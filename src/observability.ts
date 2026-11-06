import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { createHmac,randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
export const registry = new Registry();
const counter = (name:string, help:string, labelNames:string[] = []) => new Counter({ name,help,labelNames,registers:[registry] });
export const metrics = {
  transactions: counter('wager_transactions_total','Committed transactions',['status']),
  duplicates: counter('wager_duplicates_total','Persistent duplicate detections'),
  retries: counter('wager_retries_total','Retries',['source']),
  dlq: counter('wager_dlq_total','Messages sent to DLQ'),
  locks: counter('wager_lock_conflicts_total','Database lock timeouts or deadlocks'),
  reconciliation: counter('wager_reconciliation_mismatch_total','Ledger divergences'),
  lag: new Gauge({name:'wager_outbox_lag_seconds',help:'Oldest unpublished event age',registers:[registry]}),
  latency: new Histogram({name:'wager_processing_seconds',help:'Processing latency',registers:[registry]}),
};
const events=['transaction_committed','request_failed','worker_iteration_failed','visibility_extension_failed','message_dlq','reconciliation_mismatch','api_started','worker_started','worker_stopping','worker_stopped','message_failed','publication_failed','reference_failed','startup_failed'] as const;
type Event=typeof events[number];
export interface LogFields {
  correlationId?:string;messageId?:string;transactionId?:string;walletId?:string;providerId?:string;
  status?:string;errorType?:string;loop?:string;httpStatus?:number;
}
const context=new AsyncLocalStorage<LogFields>();
export function withLogContext<T>(fields:LogFields,action:()=>T):T { return context.run(fields,action); }
export function currentCorrelationId():string { return context.getStore()?.correlationId ?? crypto.randomUUID(); }
export function enrichLogContext(fields:LogFields) { const store=context.getStore();if(store)Object.assign(store,fields); }
const configuredKey=process.env.LOG_HMAC_KEY;
if(configuredKey && configuredKey.length<32)throw new Error('LOG_HMAC_KEY must contain at least 32 characters');
const key=configuredKey ?? randomBytes(32);
function identifier(value:unknown):string|null {
  if(typeof value!=='string' || !value || value.length>512)return null;
  return 'hmac:'+createHmac('sha256',key).update(value).digest('hex');
}
export function log(event:Event, fields:LogFields = {}) {
  const input={...context.getStore(),...fields};
  const record:Record<string,unknown>={timestamp:new Date().toISOString(),event:events.includes(event)?event:'invalid_log_event'};
  for(const field of ['correlationId','messageId','transactionId','walletId','providerId'] as const)record[field]=identifier(input[field]);
  if(['PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'].includes(input.status ?? ''))record.status=input.status;
  if(input.errorType!==undefined)record.errorType=['Error','AppError','ZodError','SyntaxError','QueryFailedError','TimeoutError'].includes(input.errorType)?input.errorType:'Error';
  if(['consumer','outbox','references'].includes(input.loop ?? ''))record.loop=input.loop;
  if(Number.isInteger(input.httpStatus) && input.httpStatus!>=100 && input.httpStatus!<=599)record.httpStatus=input.httpStatus;
  console.log(JSON.stringify(record));
}
