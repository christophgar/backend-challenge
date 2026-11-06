import { db } from '../src/db';
import { initQueues,consumeBatch,sqs } from '../src/queue';
await db.initialize(); await initQueues();
try { await consumeBatch(); } finally { sqs.destroy(); await db.destroy(); }
