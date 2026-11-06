import type { EntityManager } from 'typeorm';
import { db } from './db';
import { AppError, hash, keySchema, requestSchema, walletSchema, type Request } from './contracts';
import { Money } from './domain/money';
import { Wallet, WagerTransaction, type Status } from './domain/model';
import { IntegrationEvent, WalletBalanceChanged, WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference, WagerTransactionFailed } from './domain/events';
import { log, metrics,enrichLogContext } from './observability';
import { InboxMessage } from './domain/messages';
import { decide, decideIdentity } from './domain/policy';

interface WalletRow { id:string; player_id:string; currency:string; balance:string; version:number }
interface TransactionRow { id:string; idempotency_key:string; payload_hash:string; wallet_id:string; kind:string; status:Status; request:Request; result:Result; attempts:number; created_at:Date; next_attempt_at:Date; due?:boolean; reference_id?:string }
export interface Result { transactionId:string; status:Status; balance:{amount:string;currency:string}; failureCode?:string; idempotentReplay:boolean }
export interface Context { correlationId:string; messageId?:string; inboxHash?:string; reprocess?:boolean; scheduled?:boolean; permanentFailureCode?:'PERSISTENCE_CONSTRAINT_FAILURE' }
export async function enqueue(em:EntityManager,event:IntegrationEvent) {
  await em.query('INSERT INTO outbox(id,aggregate_id,payload) VALUES($1,$2,$3)',[event.eventId,event.aggregateId,event.toJSON()]);
}
export function sqlCode(error:unknown): string | undefined { return (error as {driverError?:{code?:string};code?:string})?.driverError?.code ?? (error as {code?:string})?.code; }
async function retry<T>(action:()=>Promise<T>):Promise<T> {
  for (let attempt=0;;attempt++) {
    try { return await action(); } catch(error) {
      const code=sqlCode(error);
      if (code && ['40P01','40001','55P03'].includes(code)) metrics.locks.inc();
      if (attempt<3 && code && ['23505','40P01','40001','55P03'].includes(code)) {
        metrics.retries.inc({source:'database'}); await Bun.sleep(20 * 2 ** attempt); continue;
      }
      if(code==='23505') throw new AppError('UNIQUENESS_CONFLICT',409);
      throw error;
    }
  }
}
export async function createWallet(input:unknown) {
  const value=walletSchema.parse(input), initial=Money.from(value.initialBalance), id=crypto.randomUUID();
  try { return await db.transaction(async em=> {
    await em.query('INSERT INTO wallets(id,player_id,currency,balance) VALUES($1,$2,$3,$4)',[id,value.playerId,initial.currency,initial.toString()]);
    if(initial.isPositive()) {
      const transactionId=crypto.randomUUID();
      const result={transactionId,status:'PROCESSED',balance:initial.toJSON(),idempotentReplay:false};
      await em.query(`INSERT INTO transactions(id,provider_id,external_id,idempotency_key,payload_hash,wallet_id,kind,status,request,result,processed_at)
        VALUES($1::uuid,'__internal__',$1::text,$2,$3,$4,'OPENING','PROCESSED',$5,$6,now())`,[transactionId,`opening:${id}`,hash(value),id,value,result]);
      await em.query(`INSERT INTO ledger(id,wallet_id,transaction_id,currency,direction,amount,balance_before,balance_after)
        VALUES($1,$2,$3,$4,'CREDIT',$5,0,$5)`,[crypto.randomUUID(),id,transactionId,initial.currency,initial.toString()]);
      await enqueue(em,new WagerTransactionProcessed(id,id,{...result,kind:'OPENING'}));
      await enqueue(em,new WalletBalanceChanged(id,id,{walletId:id,transactionId,direction:'CREDIT',money:initial.toJSON(),balanceBefore:Money.zero(initial.currency).toJSON(),balanceAfter:initial.toJSON(),walletVersion:1}));
    }
    return {id,playerId:value.playerId,balance:initial.toJSON(),version:1};
  }); } catch(error) { if(sqlCode(error)==='23505') throw new AppError('WALLET_ALREADY_EXISTS',409); throw error; }
}

export async function processWager(input:unknown,keyInput:unknown,ctx:Context):Promise<Result> {
  const request=requestSchema.parse(input), key=keySchema.parse(keyInput), payloadHash=hash(request);
  enrichLogContext({correlationId:ctx.correlationId,messageId:ctx.messageId,walletId:request.walletId,providerId:request.providerId});
  if(request.providerId==='__internal__') throw new AppError('RESERVED_PROVIDER',400);
  const end=ctx.permanentFailureCode ? ()=>{} : metrics.latency.startTimer();
  try {
    const result=await retry(()=>db.transaction(async em=> {
      await em.query("SET LOCAL lock_timeout='5s'");
      if(ctx.messageId) {
        const message=InboxMessage.receive(ctx.messageId,'wager',ctx.inboxHash ?? payloadHash);
        const inserted=await em.query(`INSERT INTO inbox(consumer_name,message_id,payload_hash) VALUES('wager', $1,$2)
          ON CONFLICT DO NOTHING RETURNING message_id`,[message.messageId,message.payloadHash]);
        if(!inserted.length) {
          const [inbox]=await em.query("SELECT * FROM inbox WHERE consumer_name='wager' AND message_id=$1",[ctx.messageId]);
          if(inbox.payload_hash !== (ctx.inboxHash ?? payloadHash)) throw new AppError('INBOX_PAYLOAD_CONFLICT',409);
        }
      }
      const [row]:WalletRow[]=await em.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE',[request.walletId]);
      if(!row) throw new AppError('WALLET_NOT_FOUND',404);
      const existing:TransactionRow[]=await em.query('SELECT *, next_attempt_at<=clock_timestamp() AS due FROM transactions WHERE idempotency_key=$1 OR (provider_id=$2 AND external_id=$3)',[key,request.providerId,request.externalTransactionId]);
      let tx=existing[0];
      const identity=decideIdentity(key,payloadHash,existing.map(t=>({key:t.idempotency_key,payloadHash:t.payload_hash,status:t.status})),ctx.reprocess);
      if(identity==='IDEMPOTENCY_CONFLICT' || identity==='EXTERNAL_ID_CONFLICT') throw new AppError(identity,409);
      if(tx) {
        if(identity==='REPLAY' || (ctx.scheduled && !tx.due)) {
          if(ctx.messageId) await em.query("UPDATE inbox SET processed_at=now() WHERE consumer_name='wager' AND message_id=$1",[ctx.messageId]);
          return {...tx.result,idempotentReplay:true};
        }
      } else {
        const id=crypto.randomUUID();
        [tx]=await em.query(`INSERT INTO transactions(id,provider_id,external_id,idempotency_key,payload_hash,wallet_id,kind,status,request)
          VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8) RETURNING *`,[id,request.providerId,request.externalTransactionId,key,payloadHash,row.id,request.kind,request]);
      }
      const wallet=Wallet.rehydrate(row.id,row.player_id,Money.from({amount:fixed(row.balance),currency:row.currency}),row.version);
      enrichLogContext({transactionId:tx.id});
      const state=WagerTransaction.rehydrate('PENDING'), money=Money.from(request.money);
      let reference:TransactionRow|undefined;
      let alreadyReversed=false;
      if(request.referenceExternalTransactionId) {
        [reference]=await em.query('SELECT * FROM transactions WHERE provider_id=$1 AND external_id=$2',[request.providerId,request.referenceExternalTransactionId]);
        if(reference && ['REFUND','ROLLBACK'].includes(request.kind)) {
          const reversed=await em.query("SELECT id FROM transactions WHERE reference_id=$1 AND kind=$2 AND status='PROCESSED'",[reference.id,request.kind]);
          alreadyReversed=reversed.length>0;
        }
      }
      const decision=decide({operation:{...request,money},wallet:{playerId:wallet.playerId,balance:wallet.balance},alreadyReversed,
        attempts:tx.attempts,ageMs:Date.now()-new Date(tx.created_at).getTime(),
        reference:reference ? {providerId:request.providerId,playerId:reference.request.playerId,walletId:reference.wallet_id,roundId:reference.request.roundId,
          kind:reference.kind,status:reference.status,money:reference.request.money ? Money.from(reference.request.money) : Money.zero(row.currency)} : undefined});
      if(ctx.permanentFailureCode) state.fail(ctx.permanentFailureCode);
      else if(decision.status==='REJECTED') state.reject(decision.failureCode);
      else if(decision.status==='PENDING_REFERENCE') state.markPendingReference();
      else {
        state.markProcessed();
        if(decision.direction) {
          const direction=decision.direction;
          const entry=wallet.move(tx.id,direction,money);
          await em.query('UPDATE wallets SET balance=$2,version=$3,updated_at=now() WHERE id=$1',[row.id,wallet.balance.toString(),wallet.version]);
          await em.query(`INSERT INTO ledger(id,wallet_id,transaction_id,currency,direction,amount,balance_before,balance_after)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[crypto.randomUUID(),row.id,tx.id,money.currency,direction,money.toString(),entry.balanceBefore.toString(),entry.balanceAfter.toString()]);
          await enqueue(em,new WalletBalanceChanged(row.id,ctx.correlationId,{walletId:row.id,transactionId:tx.id,direction,money:money.toJSON(),balanceBefore:entry.balanceBefore.toJSON(),balanceAfter:entry.balanceAfter.toJSON(),walletVersion:wallet.version},ctx.messageId));
        }
      }
      const result:Result={transactionId:tx.id,status:state.status,balance:wallet.balance.toJSON(),failureCode:state.failureCode,idempotentReplay:false};
      await em.query(`UPDATE transactions SET status=$2,result=$3,reference_id=$4,attempts=attempts+1,
        next_attempt_at=now()+($5 * interval '1 second'),processed_at=CASE WHEN $2 IN ('PROCESSED','REJECTED','FAILED') THEN now() ELSE NULL END WHERE id=$1`,
        [tx.id,state.status,result,reference?.id ?? null,Math.min(3600,2 ** tx.attempts)]);
      if(state.status!=='PENDING_REFERENCE' || tx.status!=='PENDING_REFERENCE') {
        const Event=state.status==='PROCESSED'?WagerTransactionProcessed:state.status==='REJECTED'?WagerTransactionRejected:state.status==='FAILED'?WagerTransactionFailed:WagerTransactionPendingReference;
        await enqueue(em,new Event(row.id,ctx.correlationId,{...result,kind:request.kind},ctx.messageId));
      }
      if(ctx.messageId) await em.query("UPDATE inbox SET processed_at=now() WHERE consumer_name='wager' AND message_id=$1",[ctx.messageId]);
      return result;
    }));
    if(result.idempotentReplay) metrics.duplicates.inc(); else metrics.transactions.inc({status:result.status});
    log('transaction_committed',{correlationId:ctx.correlationId,messageId:ctx.messageId,transactionId:result.transactionId,walletId:request.walletId,providerId:request.providerId,status:result.status});
    return result;
  } catch(error) {
    // Only after the failed financial transaction has rolled back. Never convert
    // ambiguous connectivity errors or a failed SQS ack into financial failure.
    if(!ctx.permanentFailureCode && ['22003','23514'].includes(sqlCode(error) ?? ''))
      return await processWager(input,keyInput,{...ctx,reprocess:true,scheduled:false,permanentFailureCode:'PERSISTENCE_CONSTRAINT_FAILURE'});
    throw error;
  } finally { end(); }
}
export function fixed(value:string):string { const [whole,fraction='']=value.split('.'); return `${whole}.${fraction.padEnd(2,'0')}`; }
export async function getWallet(id:string) {
  const [row]:WalletRow[]=await db.query('SELECT * FROM wallets WHERE id=$1',[id]);
  if(!row) throw new AppError('WALLET_NOT_FOUND',404);
  return {id:row.id,playerId:row.player_id,balance:{amount:fixed(row.balance),currency:row.currency},version:row.version};
}
export async function reconcile(id:string) {
  return db.transaction('REPEATABLE READ',async em=> {
    const [row]=await em.query(`SELECT w.balance::text,w.currency,coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)::text AS calculated,count(l.id)::integer AS entries
      FROM wallets w LEFT JOIN ledger l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id`,[id]);
    if(!row) throw new AppError('WALLET_NOT_FOUND',404);
    const stored=Money.from({amount:fixed(row.balance),currency:row.currency});
    const calculated=Money.from({amount:fixed(row.calculated),currency:row.currency});
    const difference=stored.subtract(calculated), consistent=difference.isZero();
    if(!consistent) { metrics.reconciliation.inc(); log('reconciliation_mismatch',{walletId:id}); }
    return {walletId:id,storedBalance:stored.toJSON(),calculatedBalance:calculated.toJSON(),difference:difference.toJSON(),consistent,checkedEntries:row.entries};
  });
}
