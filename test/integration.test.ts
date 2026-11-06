import { beforeAll, afterAll, afterEach, test, expect,spyOn } from 'bun:test';
import { withLogContext } from '../src/observability';
import { createDataSource } from '../src/db';
const db=createDataSource(process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:55432/wagering');
import { createWallet, processWager, getWallet, reconcile,enqueue } from '../src/service';
import { WagerTransactionProcessed } from '../src/domain/events';
import { LedgerIndex1793920000001 } from '../src/migrations/ledger-index';
import { initQueues, publishBatch, retryReferences, consumeBatch, queues, sqs } from '../src/queue';
import { SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import type { Request } from '../src/contracts';
import { Initial1793920000000 } from '../src/migrations/initial';

const ctx=()=>({correlationId:crypto.randomUUID()});
async function rejects(action:Promise<unknown>,message?:string) {
  let caught:unknown;
  try { await action; } catch(error) { caught=error; }
  expect(caught).toBeDefined();
  if(message) expect((caught as Error).message).toContain(message);
}
async function fixture(amount='100.00') {
  const playerId=crypto.randomUUID();
  const wallet=await createWallet({playerId,initialBalance:{amount,currency:'BRL'}});
  const request:Request={providerId:'test-'+crypto.randomUUID(),externalTransactionId:crypto.randomUUID(),walletId:wallet.id,playerId,roundId:'round',gameId:'game',kind:'BET',money:{amount:'80.00',currency:'BRL'}};
  return {wallet,request};
}
beforeAll(async()=> { await db.initialize(); await db.runMigrations(); const {db:runtime}=await import('../src/db');await runtime.initialize(); await initQueues(); });
afterAll(async()=> { sqs.destroy();const {db:runtime}=await import('../src/db');await runtime.destroy(); await db.destroy(); });
afterEach(async()=>{
  const inconsistent=await db.query(`SELECT w.id FROM wallets w WHERE w.balance <> (SELECT coalesce(sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0) FROM ledger l WHERE l.wallet_id=w.id)`);
  expect(inconsistent).toHaveLength(0);
});
test('50 parallel duplicates debit once and replay historical balance',async()=>{
  const {wallet,request}=await fixture(); const key=crypto.randomUUID();
  const results=await Promise.all(Array.from({length:50},()=>processWager(request,key,ctx())));
  expect(results.filter(r=>!r.idempotentReplay)).toHaveLength(1);
  expect(new Set(results.map(r=>r.transactionId)).size).toBe(1);
  expect((await getWallet(wallet.id)).balance.amount).toBe('20.00');
  await processWager({...request,externalTransactionId:'win',kind:'WIN',money:{amount:'5.00',currency:'BRL'}},crypto.randomUUID(),ctx());
  expect((await processWager(request,key,ctx())).balance.amount).toBe('20.00');
  expect((await reconcile(wallet.id)).consistent).toBe(true);
  await rejects(processWager({...request,money:{amount:'70.00',currency:'BRL'}},key,ctx()),'IDEMPOTENCY_CONFLICT');
});
test('two concurrent 80.00 bets on 100.00 produce one debit',async()=>{
  const {wallet,request}=await fixture();
  const results=await Promise.all(['a','b'].map(id=>processWager({...request,externalTransactionId:id},crypto.randomUUID(),ctx())));
  expect(results.map(r=>r.status).sort()).toEqual(['PROCESSED','REJECTED']);
  expect((await getWallet(wallet.id)).balance.amount).toBe('20.00');
  const [count]=await db.query("SELECT count(*)::int AS n FROM ledger WHERE wallet_id=$1 AND direction='DEBIT'",[wallet.id]);
  expect(count.n).toBe(1); expect((await reconcile(wallet.id)).consistent).toBe(true);
});
test('out-of-order refund resolves; second reversal and negative rollback reject',async()=>{
  const {wallet,request}=await fixture();
  const refund={...request,kind:'REFUND',externalTransactionId:'refund',referenceExternalTransactionId:request.externalTransactionId};
  const key=crypto.randomUUID();
  expect((await processWager(refund,key,ctx())).status).toBe('PENDING_REFERENCE');
  await processWager(request,crypto.randomUUID(),ctx());
  expect((await processWager(refund,key,{...ctx(),reprocess:true})).status).toBe('PROCESSED');
  expect((await getWallet(wallet.id)).balance.amount).toBe('100.00');
  expect((await processWager({...refund,externalTransactionId:'again'},crypto.randomUUID(),ctx())).failureCode).toBe('ALREADY_REVERSED');
  await processWager({...request,externalTransactionId:'spend',money:{amount:'100.00',currency:'BRL'}},crypto.randomUUID(),ctx());
  const reverse={...refund,kind:'ROLLBACK',externalTransactionId:'undo-refund',referenceExternalTransactionId:'refund'};
  expect((await processWager(reverse,crypto.randomUUID(),ctx())).failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
  expect((await reconcile(wallet.id)).consistent).toBe(true);
});
test('LOSS has no ledger; currency and reference scope failures are audit records',async()=>{
  const {wallet,request}=await fixture();
  const loss=await processWager({...request,kind:'LOSS',money:{amount:'0.00',currency:'BRL'}},crypto.randomUUID(),ctx());
  expect(loss.status).toBe('PROCESSED');
  const [count]=await db.query('SELECT count(*)::int AS n FROM ledger WHERE transaction_id=$1',[loss.transactionId]); expect(count.n).toBe(0);
  expect((await getWallet(wallet.id)).version).toBe(1);
  expect((await processWager({...request,externalTransactionId:'usd',money:{amount:'1.00',currency:'USD'}},crypto.randomUUID(),ctx())).failureCode).toBe('CURRENCY_MISMATCH');
  expect((await reconcile(wallet.id)).consistent).toBe(true);
});
test('SQL constraints enforce ledger immutability, nonnegativity, and matching balance',async()=>{
  const {wallet}=await fixture();
  await rejects(db.query('UPDATE wallets SET balance=-1,version=version+1 WHERE id=$1',[wallet.id]));
  await rejects(db.query('UPDATE wallets SET balance=50,version=version+1 WHERE id=$1',[wallet.id]),'BALANCE_LEDGER_MISMATCH');
  await rejects(db.query('UPDATE ledger SET amount=1 WHERE wallet_id=$1',[wallet.id]),'IMMUTABLE_LEDGER');
  await rejects(db.query('DELETE FROM ledger WHERE wallet_id=$1',[wallet.id]),'IMMUTABLE_LEDGER');
  expect((await reconcile(wallet.id)).consistent).toBe(true);
});
test('financial failure rolls back inbox and all writes',async()=>{
  const {wallet,request}=await fixture(); const key=crypto.randomUUID();
  await processWager(request,key,ctx()); const messageId=crypto.randomUUID();
  await rejects(processWager({...request,kind:'WIN'},key,{...ctx(),messageId}));
  const rows=await db.query('SELECT * FROM inbox WHERE message_id=$1',[messageId]); expect(rows).toHaveLength(0);
  expect((await reconcile(wallet.id)).consistent).toBe(true);
});
test('SQS redelivery and concurrent publishers preserve committed effects',async()=>{
  const {wallet,request}=await fixture(); const messageId=crypto.randomUUID();
  const body={messageId,type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{...request,idempotencyKey:crypto.randomUUID()}};
  for(let i=0;i<2;i++) {
    await sqs.send(new SendMessageCommand({QueueUrl:queues.input,MessageBody:JSON.stringify(body),MessageGroupId:wallet.id,MessageDeduplicationId:crypto.randomUUID()}));
    await consumeBatch();
  }
  expect((await getWallet(wallet.id)).balance.amount).toBe('20.00');
  const [inbox]=await db.query('SELECT count(*)::int AS n FROM inbox WHERE message_id=$1',[messageId]); expect(inbox.n).toBe(1);
  for(let i=0;i<5;i++) await Promise.all([publishBatch(),publishBatch()]);
  const [pending]=await db.query('SELECT count(*)::int AS n FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL',[wallet.id]); expect(pending.n).toBe(0);
  expect((await reconcile(wallet.id)).consistent).toBe(true);
});
test('permanent invalid SQS message is sent to DLQ',async()=>{
  const body='invalid-'+crypto.randomUUID();
  await sqs.send(new SendMessageCommand({QueueUrl:queues.input,MessageBody:body,MessageGroupId:crypto.randomUUID(),MessageDeduplicationId:crypto.randomUUID()}));
  await consumeBatch();
  const result=await sqs.send(new ReceiveMessageCommand({QueueUrl:queues.dlq,WaitTimeSeconds:2,MaxNumberOfMessages:10}));
  expect(result.Messages?.some(m=>m.Body===body)).toBe(true);
  for(const m of result.Messages ?? []) await sqs.send(new DeleteMessageCommand({QueueUrl:queues.dlq,ReceiptHandle:m.ReceiptHandle}));
});
test('three actual API processes handle shared-wallet contention',async()=>{
  const children=[3101,3102,3103].map(port=>Bun.spawn(['bun','src/main.ts'],{env:{...process.env,PORT:String(port)},stdout:'ignore',stderr:'pipe'}));
  try {
    for(const port of [3101,3102,3103]) {
      let ready=false;
      for(let i=0;i<100;i++) { try { if((await fetch(`http://localhost:${port}/health/ready`)).ok) {ready=true;break;} } catch {} await Bun.sleep(100); }
      expect(ready).toBe(true);
    }
    const {wallet,request}=await fixture(); const key=crypto.randomUUID();
    const results=await Promise.all(Array.from({length:50},async(_,i)=>{
      const response=await fetch(`http://localhost:${3101+i%3}/wagering/transactions`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(request)});
      expect(response.status).toBe(200); return response.json() as Promise<{transactionId:string}>;
    }));
    expect(new Set(results.map(r=>r.transactionId)).size).toBe(1);
    expect((await getWallet(wallet.id)).balance.amount).toBe('20.00'); expect((await reconcile(wallet.id)).consistent).toBe(true);
  } finally { for(const child of children) child.kill(); await Promise.all(children.map(c=>c.exited)); }
});
test('independent wallets progress while another wallet is locked',async()=>{
  const first=await fixture(), second=await fixture();
  const runner=db.createQueryRunner(); await runner.connect(); await runner.startTransaction();
  try {
    await runner.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE',[first.wallet.id]);
    const result=await processWager(second.request,crypto.randomUUID(),ctx());
    expect(result.status).toBe('PROCESSED');
  } finally { await runner.rollbackTransaction(); await runner.release(); }
  expect((await reconcile(first.wallet.id)).consistent).toBe(true);
  expect((await reconcile(second.wallet.id)).consistent).toBe(true);
});
test('reference worker expires unresolved reference with an auditable rejection',async()=>{
  const {wallet,request}=await fixture();
  const result=await processWager({...request,kind:'ROLLBACK',referenceExternalTransactionId:'missing'},crypto.randomUUID(),ctx());
  await db.query("UPDATE transactions SET attempts=16,next_attempt_at=now() WHERE id=$1",[result.transactionId]);
  // Existing test fixtures may precede this row in the worker's bounded batch.
  for(let i=0;i<50;i++) {
    await retryReferences();
    const [current]=await db.query('SELECT status FROM transactions WHERE id=$1',[result.transactionId]);
    if(current.status==='REJECTED')break;
  }
  const [row]=await db.query('SELECT result FROM transactions WHERE id=$1',[result.transactionId]);
  expect(row.result.failureCode).toBe('REFERENCE_NOT_FOUND');
  expect((await reconcile(wallet.id)).consistent).toBe(true);
});
test('crash after commit before ack survives actual process restart and redelivery',async()=>{
  const {wallet,request}=await fixture(); const messageId=crypto.randomUUID();
  const body={messageId,type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{...request,idempotencyKey:crypto.randomUUID()}};
  await sqs.send(new SendMessageCommand({QueueUrl:queues.input,MessageBody:JSON.stringify(body),MessageGroupId:wallet.id,MessageDeduplicationId:crypto.randomUUID()}));
  // Reduce only this message's visibility before the crashing consumer receives it.
  const received=await sqs.send(new ReceiveMessageCommand({QueueUrl:queues.input,WaitTimeSeconds:2}));
  expect(received.Messages).toHaveLength(1);
  await sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:queues.input,ReceiptHandle:received.Messages![0]!.ReceiptHandle,VisibilityTimeout:0}));
  const child=Bun.spawn(['bun','test/crash-consumer.ts'],{env:{...process.env,NODE_ENV:'test',TEST_CRASH_AFTER_COMMIT:'1'},stdout:'ignore',stderr:'pipe'});
  expect(await child.exited).toBe(91);
  expect((await getWallet(wallet.id)).balance.amount).toBe('20.00');
  // FIFO visibility expires naturally after the configured 60 seconds.
  let replayed=false;
  for(let i=0;i<35;i++) {
    const r=await sqs.send(new ReceiveMessageCommand({QueueUrl:queues.input,WaitTimeSeconds:2}));
    if(r.Messages?.length) {
      expect(r.Messages[0]!.Body).toBe(JSON.stringify(body));
      await sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:queues.input,ReceiptHandle:r.Messages[0]!.ReceiptHandle,VisibilityTimeout:0}));
      const restarted=Bun.spawn(['bun','test/crash-consumer.ts'],{env:{...process.env,NODE_ENV:'test',TEST_CRASH_AFTER_COMMIT:'0'},stdout:'ignore',stderr:'pipe'});
      expect(await restarted.exited).toBe(0); replayed=true;break;
    }
  }
  expect(replayed).toBe(true);
  expect((await getWallet(wallet.id)).balance.amount).toBe('20.00');
  expect((await reconcile(wallet.id)).consistent).toBe(true);
});
test('migration up/down is reversible in an isolated transactional schema',async()=>{
  const runner=db.createQueryRunner(); await runner.connect(); await runner.startTransaction();
  const schema='migration_test_'+crypto.randomUUID().replaceAll('-','');
  try {
    await runner.query(`CREATE SCHEMA "${schema}"`);
    await runner.query(`SET LOCAL search_path TO "${schema}"`);
    const migration=new Initial1793920000000(); await migration.up(runner);
    const index=new LedgerIndex1793920000001();await index.up(runner);await index.down(runner);await index.up(runner);
    expect((await runner.query("SELECT to_regclass('wallets')::text AS name"))[0].name).toBe('wallets');
    await migration.down(runner);
    expect((await runner.query("SELECT to_regclass('wallets')::text AS name"))[0].name).toBeNull();
    await migration.up(runner);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});
test('outbox write failure rolls back wallet, transaction, ledger and inbox',async()=>{
  const {wallet,request}=await fixture(); const messageId=crypto.randomUUID();
  // Deliberately fail only rows for this fixture. Remove the test trigger in finally.
  const suffix=crypto.randomUUID().replaceAll('-','');
  const fn='fail_outbox_'+suffix;
  await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_id='${wallet.id}'::uuid THEN RAISE EXCEPTION 'TEST_OUTBOX_FAILURE'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    await rejects(processWager(request,crypto.randomUUID(),{...ctx(),messageId}),'TEST_OUTBOX_FAILURE');
    expect((await getWallet(wallet.id)).balance.amount).toBe('100.00');
    expect((await db.query('SELECT id FROM transactions WHERE provider_id=$1',[request.providerId]))).toHaveLength(0);
    expect((await db.query('SELECT message_id FROM inbox WHERE message_id=$1',[messageId]))).toHaveLength(0);
    expect((await reconcile(wallet.id)).checkedEntries).toBe(1);
  } finally {
    await db.query(`DROP TRIGGER ${fn} ON outbox`); await db.query(`DROP FUNCTION ${fn}()`);
  }
});
test('20 different wallets process concurrently with exact ledger balances',async()=>{
  const fixtures=await Promise.all(Array.from({length:20},()=>fixture()));
  const results=await Promise.all(fixtures.map(f=>processWager(f.request,crypto.randomUUID(),ctx())));
  expect(results.every(r=>r.status==='PROCESSED' && r.balance.amount==='20.00')).toBe(true);
  for(const f of fixtures) expect((await reconcile(f.wallet.id)).consistent).toBe(true);
});
test('WIN credits, ROLLBACK debits WIN and credits BET',async()=>{
  const {wallet,request}=await fixture();
  await processWager(request,crypto.randomUUID(),ctx());
  const win={...request,kind:'WIN',externalTransactionId:'win',money:{amount:'30.00',currency:'BRL'},referenceExternalTransactionId:request.externalTransactionId};
  expect((await processWager(win,crypto.randomUUID(),ctx())).balance.amount).toBe('50.00');
  expect((await processWager({...win,kind:'ROLLBACK',externalTransactionId:'undo-win',referenceExternalTransactionId:'win'},crypto.randomUUID(),ctx())).balance.amount).toBe('20.00');
  expect((await processWager({...request,kind:'ROLLBACK',externalTransactionId:'undo-bet',referenceExternalTransactionId:request.externalTransactionId},crypto.randomUUID(),ctx())).balance.amount).toBe('100.00');
  expect((await reconcile(wallet.id)).consistent).toBe(true);
});
test('SQS transient SQL failure retries without persisting partial effects',async()=>{
  const {wallet,request}=await fixture(),messageId=crypto.randomUUID();
  const fn='transient_'+crypto.randomUUID().replaceAll('-','');
  await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.wallet_id='${wallet.id}'::uuid THEN RAISE EXCEPTION 'TEST_TRANSIENT'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  const body={messageId,type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{...request,idempotencyKey:crypto.randomUUID()}};
  try {
    await sqs.send(new SendMessageCommand({QueueUrl:queues.input,MessageBody:JSON.stringify(body),MessageGroupId:wallet.id,MessageDeduplicationId:crypto.randomUUID()}));
    await consumeBatch();
    expect((await getWallet(wallet.id)).balance.amount).toBe('100.00');
    expect(await db.query('SELECT * FROM inbox WHERE message_id=$1',[messageId])).toHaveLength(0);
  } finally { await db.query(`DROP TRIGGER ${fn} ON transactions`); await db.query(`DROP FUNCTION ${fn}()`); }
  await Bun.sleep(2100); await consumeBatch();
  expect((await getWallet(wallet.id)).balance.amount).toBe('20.00');
});
test('outbox publication failure schedules retry and two publisher processes recover',async()=>{
  // Drain earlier fixtures so the publisher's bounded batch reaches this scenario.
  for(let i=0;i<50;i++) {
    const [pending]=await db.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL AND next_attempt_at<=now()');
    if(pending.n===0) break;
    await publishBatch();
  }
  const {wallet}=await fixture(); const original=queues.events;
  try {
    queues.events=original.replace('wager-events.fifo','missing-'+crypto.randomUUID()+'.fifo');
    await publishBatch();
    const rows=await db.query('SELECT attempts,published_at,next_attempt_at>occurred_at AS backed_off FROM outbox WHERE aggregate_id=$1',[wallet.id]);
    expect(rows.every((r:any)=>r.attempts>0 && r.published_at===null && r.backed_off)).toBe(true);
  } finally { queues.events=original; }
  await Bun.sleep(1100);
  const children=Array.from({length:2},()=>Bun.spawn(['bun','test/publisher.ts'],{stdout:'ignore',stderr:'pipe'}));
  expect(await Promise.all(children.map(c=>c.exited))).toEqual([0,0]);
  expect(await db.query('SELECT id FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL',[wallet.id])).toHaveLength(0);
});
test('permanent persistence failure becomes audited FAILED without any movement',async()=>{
  const {wallet,request}=await fixture(),key=crypto.randomUUID(),messageId=crypto.randomUUID();
  const fn='fatal_'+crypto.randomUUID().replaceAll('-','');
  await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.wallet_id='${wallet.id}'::uuid THEN RAISE EXCEPTION 'TEST_PERMANENT' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON ledger FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    const result=await processWager(request,key,{...ctx(),messageId});
    expect(result.status).toBe('FAILED');expect(result.failureCode).toBe('PERSISTENCE_CONSTRAINT_FAILURE');
    expect((await getWallet(wallet.id)).balance.amount).toBe('100.00');
    expect((await reconcile(wallet.id)).checkedEntries).toBe(1);
    const [event]=await db.query("SELECT payload FROM outbox WHERE aggregate_id=$1 AND payload->>'eventType'='WagerTransactionFailed'",[wallet.id]);
    expect(event.payload.data.transactionId).toBe(result.transactionId);
    expect((await processWager(request,key,ctx())).idempotentReplay).toBe(true);
    await rejects(db.query("UPDATE transactions SET status='PENDING' WHERE id=$1",[result.transactionId]),'TERMINAL_TRANSACTION');
  } finally { await db.query(`DROP TRIGGER ${fn} ON ledger`);await db.query(`DROP FUNCTION ${fn}()`); }
});
test('concurrent scheduled reference workers do not consume future retries',async()=>{
  const {request}=await fixture();const key=crypto.randomUUID();
  const pending={...request,kind:'REFUND',referenceExternalTransactionId:'missing'};
  const result=await processWager(pending,key,ctx());
  await db.query('UPDATE transactions SET next_attempt_at=now() WHERE id=$1',[result.transactionId]);
  await Promise.all(Array.from({length:10},()=>processWager(pending,key,{...ctx(),reprocess:true,scheduled:true})));
  const [row]=await db.query('SELECT attempts FROM transactions WHERE id=$1',[result.transactionId]);
  expect(row.attempts).toBe(2);
});
test('successful send followed by SQL failure leaves outbox safely retryable',async()=>{
  for(let i=0;i<50;i++) if(await publishBatch()===0) break;
  const {wallet}=await fixture();const fn='publication_'+crypto.randomUUID().replaceAll('-','');
  await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_id='${wallet.id}'::uuid THEN RAISE EXCEPTION 'TEST_PUBLISHED_SQL_FAILURE'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    await rejects(publishBatch(),'TEST_PUBLISHED_SQL_FAILURE');
    const rows=await db.query('SELECT published_at FROM outbox WHERE aggregate_id=$1',[wallet.id]);expect(rows.every((r:any)=>r.published_at===null)).toBe(true);
  } finally {await db.query(`DROP TRIGGER ${fn} ON outbox`);await db.query(`DROP FUNCTION ${fn}()`);}
  await publishBatch();
  expect(await db.query('SELECT id FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL',[wallet.id])).toHaveLength(0);
});
test('publisher crash after SQS send recovers committed outbox on restart',async()=>{
  for(let i=0;i<50;i++) if(await publishBatch()===0) break;
  const {wallet}=await fixture();
  const child=Bun.spawn(['bun','test/crash-publisher.ts'],{env:{...process.env,NODE_ENV:'test',TEST_CRASH_AFTER_PUBLISH:'1'},stdout:'ignore',stderr:'pipe'});
  expect(await child.exited).toBe(92);
  expect((await db.query('SELECT id FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL',[wallet.id])).length).toBe(2);
  const restarted=Bun.spawn(['bun','test/publisher.ts'],{stdout:'ignore',stderr:'pipe'});expect(await restarted.exited).toBe(0);
  expect(await db.query('SELECT id FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL',[wallet.id])).toHaveLength(0);
});
test('SIGTERM drains a consumer waiting on a wallet lock before exiting',async()=>{
  const {wallet,request}=await fixture(),name='wager-shutdown-'+crypto.randomUUID();
  const runner=db.createQueryRunner();await runner.connect();await runner.startTransaction();
  async function docker(args:string[]) {const p=Bun.spawn(['docker',...args],{stdout:'pipe',stderr:'pipe'});const output=await new Response(p.stdout).text();if(await p.exited!==0)throw new Error(await new Response(p.stderr).text());return output.trim();}
  try {
    await runner.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE',[wallet.id]);
    const body={messageId:crypto.randomUUID(),type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{...request,idempotencyKey:crypto.randomUUID()}};
    await sqs.send(new SendMessageCommand({QueueUrl:queues.input,MessageBody:JSON.stringify(body),MessageGroupId:wallet.id,MessageDeduplicationId:crypto.randomUUID()}));
    await docker(['run','-d','--name',name,'--network','backend-challenge_default','-e','DATABASE_URL=postgres://wagering_app:local_app_only@postgres:5432/wagering','-e','SQS_ENDPOINT=http://localstack:4566','-e',`APP_NAME=${name}`,'backend-challenge-worker','bun','src/worker.ts']);
    let locked=false;
    for(let i=0;i<50;i++) {const rows=await db.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[name]);if(rows.length){locked=true;break;}await Bun.sleep(100);}
    expect(locked).toBe(true);await docker(['kill','--signal','TERM',name]);
    await runner.commitTransaction();
    expect(await docker(['wait',name])).toBe('0');
    expect((await getWallet(wallet.id)).balance.amount).toBe('20.00');
    const logs=await docker(['logs',name]);expect(logs).toContain('worker_stopped');
  } finally {if(runner.isTransactionActive)await runner.rollbackTransaction();await runner.release();await docker(['rm','-f',name]).catch(()=>{});}
});
test('runtime role cannot modify ledger or disable its SQL protections',async()=>{
  const [role]=await db.query("SELECT rolsuper,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname='wagering_app'");
  expect(role).toEqual({rolsuper:false,rolcreaterole:false,rolcreatedb:false});
  for(const sql of ['UPDATE ledger SET amount=amount WHERE false','DELETE FROM ledger WHERE false','TRUNCATE ledger','ALTER TABLE ledger DISABLE TRIGGER ALL']) {
    await rejects(db.transaction(async em=>{await em.query('SET LOCAL ROLE wagering_app');await em.query(sql);}));
  }
});
test('publisher cannot see an outbox event until its transaction commits',async()=>{
  for(let i=0;i<50;i++)if(await publishBatch()===0)break;
  const {wallet}=await fixture();await publishBatch();
  const runner=db.createQueryRunner();await runner.connect();await runner.startTransaction();
  const event=new WagerTransactionProcessed(wallet.id,crypto.randomUUID(),{test:true});
  try {
    await enqueue(runner.manager,event);
    expect(await publishBatch()).toBe(0);
    expect(await db.query('SELECT id FROM outbox WHERE id=$1',[event.eventId])).toHaveLength(0);
    await runner.commitTransaction();await publishBatch();
    const [row]=await db.query('SELECT published_at FROM outbox WHERE id=$1',[event.eventId]);expect(row.published_at).not.toBeNull();
  } finally {if(runner.isTransactionActive)await runner.rollbackTransaction();await runner.release();}
});
test('native runtime uses the restricted role by default',async()=>{
  const {db:runtime}=await import('../src/db');
  const [row]=await runtime.query("SELECT current_user AS name,has_table_privilege(current_user,'ledger','UPDATE') AS can_update,has_table_privilege(current_user,'ledger','DELETE') AS can_delete");
  expect(row.name).toBe('wagering_app');expect(row.can_update).toBe(false);expect(row.can_delete).toBe(false);
});
test('HTTP failures keep correlation while logs omit request secrets and identifiers',async()=>{
  const child=Bun.spawn(['bun','src/main.ts'],{env:{...process.env,PORT:'3104'},stdout:'pipe',stderr:'pipe'});
  const output=new Response(child.stdout).text();
  let returnedCorrelation='';const secret='private-email@example.com';
  try {
    let ready=false;
    for(let i=0;i<100;i++){try{if((await fetch('http://localhost:3104/health/ready')).ok){ready=true;break;}}catch{}await Bun.sleep(100);}
    expect(ready).toBe(true);
    const response=await fetch('http://localhost:3104/wagering/transactions',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':secret,'X-Correlation-Id':secret,'Authorization':`Bearer ${secret}`},body:JSON.stringify({providerId:secret,externalTransactionId:crypto.randomUUID(),walletId:crypto.randomUUID(),playerId:crypto.randomUUID(),roundId:'r',gameId:'g',kind:'BET',money:{amount:'987.65',currency:'BRL'}})});
    expect(response.status).toBe(404);returnedCorrelation=response.headers.get('X-Correlation-Id')!;expect(returnedCorrelation).toMatch(/^[a-f0-9-]{36}$/);
    await Bun.sleep(50);
  } finally {child.kill();await child.exited;}
  const text=await output;expect(text).not.toContain(secret);expect(text).not.toContain('987.65');expect(text).not.toContain(returnedCorrelation);
  const records=text.trim().split('\n').map(line=>JSON.parse(line));
  const failed=records.find(row=>row.event==='request_failed');expect(failed).toBeDefined();
  expect(failed.correlationId).toMatch(/^hmac:/);expect(failed.walletId).toMatch(/^hmac:/);expect(failed.providerId).toMatch(/^hmac:/);
});
test('SQS failure logs preserve message context without exposing the body',async()=>{
  const secret='sensitive-worker@example.com',messageId=crypto.randomUUID();
  const body={messageId,type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{idempotencyKey:crypto.randomUUID(),providerId:secret,externalTransactionId:crypto.randomUUID(),playerId:crypto.randomUUID(),walletId:crypto.randomUUID(),roundId:'r',gameId:'g',kind:'BET',money:{amount:'987.65',currency:'BRL'}}};
  await sqs.send(new SendMessageCommand({QueueUrl:queues.input,MessageBody:JSON.stringify(body),MessageGroupId:crypto.randomUUID(),MessageDeduplicationId:crypto.randomUUID()}));
  const spy=spyOn(console,'log').mockImplementation(()=>{});
  try {
    await withLogContext({correlationId:crypto.randomUUID(),loop:'consumer'},()=>consumeBatch());
    const lines=spy.mock.calls.map(c=>String(c[0]));
    expect(lines.join('')).not.toContain(secret);expect(lines.join('')).not.toContain('987.65');expect(lines.join('')).not.toContain(messageId);
    const failed=lines.map(line=>JSON.parse(line)).find(r=>r.event==='message_failed');
    expect(failed).toBeDefined();expect(failed.messageId).toMatch(/^hmac:/);expect(failed.correlationId).toBe(failed.messageId);expect(failed.walletId).toMatch(/^hmac:/);expect(failed.providerId).toMatch(/^hmac:/);
  } finally {spy.mockRestore();}
  const dlq=await sqs.send(new ReceiveMessageCommand({QueueUrl:queues.dlq,WaitTimeSeconds:2}));
  expect(dlq.Messages?.[0]?.Body).toBe(JSON.stringify(body));
  for(const msg of dlq.Messages ?? [])await sqs.send(new DeleteMessageCommand({QueueUrl:queues.dlq,ReceiptHandle:msg.ReceiptHandle}));
});
