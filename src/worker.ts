import { db } from './db';
import { consumeBatch, initQueues, publishBatch, retryReferences, sqs } from './queue';
import { log, registry,withLogContext } from './observability';
async function bootstrap() {
await db.initialize();
await initQueues();
let stopping=false;
const stop=()=>{stopping=true;log('worker_stopping');};
process.on('SIGTERM',stop);
process.on('SIGINT',stop);
const server=Bun.serve({port:process.env.WORKER_METRICS_PORT ?? 9090,fetch:async()=>new Response(await registry.metrics(),{headers:{'Content-Type':registry.contentType}})});
async function loop(name:string,action:()=>Promise<unknown>,pause:number) {
  while(!stopping) {
    await withLogContext({correlationId:crypto.randomUUID(),loop:name},async()=>{
      try { const result=await action(); if(pause && !(typeof result==='number' && result>0)) await Bun.sleep(pause); }
      catch(error) { log('worker_iteration_failed',{errorType:(error as Error)?.constructor?.name}); await Bun.sleep(1000); }
    });
  }
}
try {
  log('worker_started');
  await Promise.all([loop('consumer',()=>consumeBatch(()=>stopping),0),loop('outbox',()=>publishBatch(()=>stopping),100),loop('references',()=>retryReferences(()=>stopping),500)]);
} finally { server.stop(); sqs.destroy(); await db.destroy(); log('worker_stopped'); }
}
await bootstrap().catch(async error=>{
  log('startup_failed',{correlationId:crypto.randomUUID(),errorType:error?.constructor?.name});
  sqs.destroy();if(db.isInitialized)await db.destroy().catch(()=>{});process.exitCode=1;
});
