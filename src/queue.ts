import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { db } from './db';
import { AppError, envelopeSchema, hash } from './contracts';
import { processWager } from './service';
import { log, metrics,enrichLogContext } from './observability';
import { ZodError } from 'zod';
import { OutboxMessage } from './domain/messages';

export const sqs=new SQSClient({region:process.env.AWS_REGION ?? 'us-east-1',endpoint:process.env.SQS_ENDPOINT ?? 'http://localhost:4566',credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID ?? 'test',secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY ?? 'test'},maxAttempts:3,requestHandler:{connectionTimeout:3000,requestTimeout:10000}});
export const queues={input:'',dlq:'',events:''};
export async function initQueues() {
  const create=async(QueueName:string,extra:Record<string,string>={}) => {
    const r=await sqs.send(new CreateQueueCommand({QueueName,Attributes:{FifoQueue:'true',ContentBasedDeduplication:'false',...extra}}));
    return r.QueueUrl!;
  };
  queues.dlq=await create('wager-transactions-dlq.fifo');
  const attrs=await sqs.send(new GetQueueAttributesCommand({QueueUrl:queues.dlq,AttributeNames:['QueueArn']}));
  queues.input=await create('wager-transactions.fifo',{VisibilityTimeout:'60',RedrivePolicy:JSON.stringify({deadLetterTargetArn:attrs.Attributes!.QueueArn,maxReceiveCount:5})});
  queues.events=await create('wager-events.fifo');
}
export async function ready() {
  await db.query('SELECT 1');
  await sqs.send(new GetQueueAttributesCommand({QueueUrl:queues.input,AttributeNames:['QueueArn']}));
}
export async function publishBatch(stopping:()=>boolean=()=>false):Promise<number> {
  // Locks concern committed outbox rows only: no network operation occurs in a financial transaction.
  const processed=await db.transaction(async em=> {
    const rows=await em.query(`SELECT * FROM outbox WHERE published_at IS NULL AND next_attempt_at<=now()
      ORDER BY occurred_at LIMIT 20 FOR UPDATE SKIP LOCKED`);
    for(const row of rows) {
      if(stopping()) break;
      enrichLogContext({correlationId:row.payload.correlationId,messageId:row.id,walletId:row.aggregate_id,transactionId:row.payload.data?.transactionId,providerId:undefined});
      const message=OutboxMessage.rehydrate(row.attempts,row.next_attempt_at,row.published_at ?? undefined);
      try {
        await sqs.send(new SendMessageCommand({QueueUrl:queues.events,MessageBody:JSON.stringify(row.payload),MessageGroupId:row.aggregate_id,MessageDeduplicationId:row.id}));
      } catch(error) {
        log('publication_failed',{errorType:(error as Error)?.constructor?.name});
        metrics.retries.inc({source:'outbox'});
        message.scheduleRetry(new Date());
        await em.query('UPDATE outbox SET attempts=$2,next_attempt_at=$3 WHERE id=$1',[row.id,message.attempts,message.nextAttemptAt]);
        continue;
      }
      // SQL/commit failures must roll back the batch, not be mistaken for send failures.
      if(process.env.NODE_ENV==='test' && process.env.TEST_CRASH_AFTER_PUBLISH==='1') process.exit(92);
      message.markPublished(new Date());
      await em.query('UPDATE outbox SET published_at=$2,attempts=$3 WHERE id=$1',[row.id,message.publishedAt,message.attempts]);
    }
    return rows.length;
  });
  const [age]=await db.query('SELECT coalesce(extract(epoch FROM now()-min(occurred_at)),0)::float AS lag FROM outbox WHERE published_at IS NULL');
  metrics.lag.set(age.lag);
  return processed;
}
export async function retryReferences(stopping:()=>boolean=()=>false):Promise<void> {
  const rows=await db.query("SELECT request,idempotency_key FROM transactions WHERE status='PENDING_REFERENCE' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 20");
  for(const row of rows) {
    if(stopping()) break;
    metrics.retries.inc({source:'reference'});
    try { await processWager(row.request,row.idempotency_key,{correlationId:crypto.randomUUID(),reprocess:true,scheduled:true}); }
    catch(error) { log('reference_failed',{errorType:(error as Error)?.constructor?.name});throw error; }
  }
}
export async function consumeBatch(stopping:()=>boolean=()=>false):Promise<void> {
  const batch=await sqs.send(new ReceiveMessageCommand({QueueUrl:queues.input,MaxNumberOfMessages:1,WaitTimeSeconds:2,MessageSystemAttributeNames:['ApproximateReceiveCount']}));
  for(const msg of batch.Messages ?? []) {
    enrichLogContext({correlationId:crypto.randomUUID(),messageId:msg.MessageId});
    if(stopping()) {
      await sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:queues.input,ReceiptHandle:msg.ReceiptHandle,VisibilityTimeout:0}));
      return;
    }
    const visibility=setInterval(()=>void sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:queues.input,ReceiptHandle:msg.ReceiptHandle,VisibilityTimeout:60})).catch(()=>log('visibility_extension_failed')),20000);
    try {
      const parsed=envelopeSchema.parse(JSON.parse(msg.Body!));
      const {idempotencyKey,...request}=parsed.data;
      enrichLogContext({messageId:parsed.messageId,correlationId:parsed.messageId,walletId:typeof request.walletId==='string'?request.walletId:undefined,providerId:typeof request.providerId==='string'?request.providerId:undefined});
      await processWager(request,idempotencyKey,{correlationId:parsed.messageId,messageId:parsed.messageId,inboxHash:hash(parsed)});
      if(process.env.TEST_CRASH_AFTER_COMMIT==='1' && process.env.NODE_ENV==='test') process.exit(91);
      await sqs.send(new DeleteMessageCommand({QueueUrl:queues.input,ReceiptHandle:msg.ReceiptHandle}));
    } catch(error) {
      log('message_failed',{errorType:(error as Error)?.constructor?.name});
      const permanent=error instanceof ZodError || error instanceof SyntaxError || error instanceof AppError;
      const attempts=Number(msg.Attributes?.ApproximateReceiveCount ?? '1');
      if(permanent || attempts>=5) {
        await sqs.send(new SendMessageCommand({QueueUrl:queues.dlq,MessageBody:msg.Body!,MessageGroupId:'invalid',MessageDeduplicationId:msg.MessageId!}));
        await sqs.send(new DeleteMessageCommand({QueueUrl:queues.input,ReceiptHandle:msg.ReceiptHandle}));
        metrics.dlq.inc(); log('message_dlq',{messageId:msg.MessageId});
      } else {
        metrics.retries.inc({source:'sqs'});
        await sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:queues.input,ReceiptHandle:msg.ReceiptHandle,VisibilityTimeout:Math.min(300,2 ** attempts)}));
      }
    } finally { clearInterval(visibility); }
  }
}
