import { Money } from './money';
import type { Direction, Status } from './model';

export interface Operation {
  providerId:string; playerId:string; walletId:string; roundId:string;
  kind:'BET'|'WIN'|'LOSS'|'REFUND'|'ROLLBACK'; money:Money; referenceExternalTransactionId?:string;
}
export interface Reference {
  providerId:string; playerId:string; walletId:string; roundId:string;
  kind:string; money:Money; status:Status;
}
export type Decision = {status:'REJECTED';failureCode:string} | {status:'PENDING_REFERENCE'} | {status:'PROCESSED';direction:Direction|null};

/** Pure financial policy. Facts are read under the wallet lock by the application. */
export function decide(input:{operation:Operation;wallet:{playerId:string;balance:Money};reference?:Reference;alreadyReversed:boolean;attempts:number;ageMs:number}):Decision {
  const {operation:o,wallet,reference:r}=input;
  const reject=(failureCode:string):Decision=>({status:'REJECTED',failureCode});
  if(wallet.playerId!==o.playerId) return reject('PLAYER_MISMATCH');
  if(wallet.balance.currency!==o.money.currency) return reject('CURRENCY_MISMATCH');
  const reversal=o.kind==='REFUND'||o.kind==='ROLLBACK';
  if(reversal && !o.referenceExternalTransactionId) return reject('REFERENCE_REQUIRED');
  if(o.kind==='BET' && o.referenceExternalTransactionId) return reject('BET_REFERENCE_NOT_ALLOWED');
  if(o.kind==='LOSS' ? !o.money.isZero() : !o.money.isPositive()) return reject(o.kind==='LOSS'?'LOSS_AMOUNT_MUST_BE_ZERO':'POSITIVE_AMOUNT_REQUIRED');
  if(o.referenceExternalTransactionId) {
    if(!r || ['PENDING','PENDING_REFERENCE'].includes(r.status)) return input.ageMs>86400000 || input.attempts>=16 ? reject('REFERENCE_NOT_FOUND') : {status:'PENDING_REFERENCE'};
    if(r.status!=='PROCESSED') return reject('REFERENCE_NOT_PROCESSED');
    if(r.providerId!==o.providerId || r.playerId!==o.playerId || r.walletId!==o.walletId || r.roundId!==o.roundId || r.money.currency!==o.money.currency) return reject('REFERENCE_SCOPE_MISMATCH');
    if((o.kind==='REFUND' && r.kind!=='BET') || (o.kind==='ROLLBACK' && !['BET','WIN','REFUND'].includes(r.kind)) || (['WIN','LOSS'].includes(o.kind) && r.kind!=='BET')) return reject('REFERENCE_KIND_INVALID');
    if(reversal && !o.money.equals(r.money)) return reject('REFERENCE_AMOUNT_MISMATCH');
    if(reversal && input.alreadyReversed) return reject('ALREADY_REVERSED');
  }
  const direction:Direction|null=o.kind==='LOSS'?null:o.kind==='BET'?'DEBIT':o.kind==='ROLLBACK' && r?.kind!=='BET'?'DEBIT':'CREDIT';
  if(direction==='DEBIT' && wallet.balance.isLessThan(o.money)) return reject(o.kind==='BET'?'INSUFFICIENT_FUNDS':'REVERSAL_INSUFFICIENT_FUNDS');
  if(direction==='CREDIT' && !wallet.balance.add(o.money).isLessThan(Money.from({amount:'10000000000000000.00',currency:o.money.currency}))) return reject('BALANCE_LIMIT_EXCEEDED');
  return {status:'PROCESSED',direction};
}

export interface Identity {key:string;payloadHash:string;status:Status}
export function decideIdentity(key:string,payloadHash:string,matches:Identity[],reprocess=false):'NEW'|'REPLAY'|'REPROCESS'|'IDEMPOTENCY_CONFLICT'|'EXTERNAL_ID_CONFLICT' {
  if(matches.length>1 || (matches[0] && matches[0].payloadHash!==payloadHash)) return 'IDEMPOTENCY_CONFLICT';
  const stored=matches[0];
  if(!stored) return 'NEW';
  if(stored.key!==key) return 'EXTERNAL_ID_CONFLICT';
  return reprocess && stored.status==='PENDING_REFERENCE'?'REPROCESS':'REPLAY';
}
