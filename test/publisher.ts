import { db } from '../src/db';
import { initQueues,publishBatch,sqs } from '../src/queue';
await db.initialize(); await initQueues();
try { for(let i=0;i<10;i++) await publishBatch(); } finally { sqs.destroy(); await db.destroy(); }
