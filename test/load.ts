import { cpus,totalmem,platform,release } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { db } from '../src/db';

const urls=(process.env.LOAD_URLS ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002').split(',');
const integer=(name:string,fallback:number)=>{const value=Number(process.env[name] ?? fallback);if(!Number.isSafeInteger(value)||value<1)throw new Error(`Invalid ${name}`);return value;};
const count=integer('LOAD_REQUESTS',300),concurrency=integer('LOAD_CONCURRENCY',24),walletCount=integer('LOAD_WALLETS',20),drainSeconds=integer('LOAD_DRAIN_SECONDS',90);
const runId=crypto.randomUUID(),startedAt=new Date().toISOString();
const wallets:{id:string;playerId:string}[]=[];
const samples:{elapsedSeconds:number;pending:number;oldestPendingSeconds:number}[]=[];
const epoch=performance.now();
async function command(args:string[]) {
  try {const child=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});const output=await new Response(child.stdout).text();await child.exited;return output.trim();}catch{return 'unavailable';}
}
async function request(url:string,body:unknown,key?:string) {
  return fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
}
async function openWallet() {
  const playerId=crypto.randomUUID();const response=await request(`${urls[wallets.length%urls.length]}/wallets`,{playerId,initialBalance:{amount:'100000.00',currency:'BRL'}});
  if(response.status!==201)throw new Error(`Wallet setup HTTP ${response.status}`);
  const wallet=await response.json() as {id:string;playerId:string};wallets.push(wallet);return wallet;
}
async function metrics() {
  let locks=0,retries=0;
  for(const url of urls) {
    const response=await fetch(`${url}/metrics`,{signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('Metrics unavailable');
    const body=await response.text();
    locks+=Number(body.match(/^wager_lock_conflicts_total (\S+)/m)?.[1] ?? 0);
    retries+=Number(body.match(/^wager_retries_total\{source="database"\} (\S+)/m)?.[1] ?? 0);
  }
  return {locks,retries};
}
async function sample() {
  const [row]=await db.query(`SELECT count(*)::int AS pending,coalesce(extract(epoch FROM now()-min(occurred_at)),0)::float AS lag FROM outbox WHERE aggregate_id=ANY($1::uuid[]) AND published_at IS NULL`,[wallets.map(w=>w.id)]);
  const point={elapsedSeconds:(performance.now()-epoch)/1000,pending:row.pending,oldestPendingSeconds:row.lag};samples.push(point);return point;
}
function percentile(sorted:number[],p:number) { return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)] ?? 0; }
async function phase(name:string,targets:typeof wallets,requests:number,parallel:number,duplicate=false) {
  let next=0,success=0,replays=0,errors=0;const durations:number[]=[],statuses:Record<string,number>={},accepted=new Set<string>();
  const before=await metrics(),start=performance.now();
  await Promise.all(Array.from({length:parallel},async()=>{
    while(next<requests) {
      const index=next++,wallet=targets[index%targets.length]!,externalTransactionId=`${runId}:${name}:${duplicate?'same':index}`;
      const begin=performance.now();let status='network_error';
      try {
        const response=await request(`${urls[index%urls.length]}/wagering/transactions`,{providerId:`load-${runId}`,externalTransactionId,playerId:wallet.playerId,walletId:wallet.id,roundId:name,gameId:'load',kind:'BET',money:{amount:'0.01',currency:'BRL'}},externalTransactionId);
        status=String(response.status);const body=await response.json() as {status?:string;idempotentReplay?:boolean};
        if(response.status===200 && body.status==='PROCESSED') {success++;accepted.add(externalTransactionId);if(body.idempotentReplay)replays++;} else errors++;
      } catch { errors++; }
      durations.push(performance.now()-begin);statuses[status]=(statuses[status]??0)+1;
    }
  }));
  const elapsedSeconds=(performance.now()-start)/1000,after=await metrics();durations.sort((a,b)=>a-b);
  const result={name,requests,concurrency:parallel,wallets:targets.length,elapsedSeconds,throughputRps:requests/elapsedSeconds,successfulRps:success/elapsedSeconds,
    success,errors,errorRate:errors/requests,replays,uniqueAcknowledged:accepted.size,statuses,latencyMs:{p50:percentile(durations,.50),p95:percentile(durations,.95),p99:percentile(durations,.99)},lockConflicts:after.locks-before.locks,databaseRetries:after.retries-before.retries};
  console.log(JSON.stringify({phase:result}));return result;
}
await db.initialize();
let stopSampling=false;
let sampling:Promise<void>|undefined;
try {
  for(const url of urls) { const r=await fetch(`${url}/health/ready`); if(!r.ok)throw new Error(`Not ready: ${url}`); }
  const environment={bun:Bun.version,os:`${platform()} ${release()}`,cpu:cpus()[0]?.model,logicalCpus:cpus().length,hostMemoryGiB:totalmem()/1024**3,
    docker:await command(['docker','version','--format','{{.Server.Version}}']),dockerResources:await command(['docker','info','--format','CPUs={{.NCPU}} MemoryBytes={{.MemTotal}}']),
    compose:await command(['docker','compose','ps','--format','json']),postgres:(await db.query('SHOW server_version'))[0].server_version,git:await command(['git','rev-parse','HEAD']),dirty:await command(['git','status','--short'])};
  const warm=await openWallet(); const hot=await openWallet();const distributed=[];
  for(let i=0;i<walletCount;i++) distributed.push(await openWallet());
  const duplicateWallet=await openWallet();
  sampling=(async()=>{while(!stopSampling){await sample();await Bun.sleep(1000);}})();
  const warmup=await phase('warmup',[warm],30,5);
  const results=[await phase('hot-wallet',[hot],count,concurrency),await phase('distributed-wallets',distributed,count,concurrency),await phase('duplicates',[duplicateWallet],50,50,true)];
  const loadEnded=performance.now();
  let last=await sample();
  while(last.pending>0 && performance.now()-loadEnded<drainSeconds*1000) {
    console.log(JSON.stringify({draining:last}));await Bun.sleep(5000);last=await sample();
  }
  stopSampling=true;await sampling;
  const checks=[];
  for(const wallet of wallets) {
    const [row]=await db.query(`SELECT w.balance::text,coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)::text AS calculated,
      count(*) FILTER(WHERE l.direction='DEBIT')::int AS debits FROM wallets w LEFT JOIN ledger l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id`,[wallet.id]);
    const toCents=(value:string)=>{const [a,b='']=value.split('.');return BigInt(a!)*100n+BigInt(b.padEnd(2,'0'));};
    const expected=10000000n-BigInt(row.debits);
    const distributedIndex=distributed.findIndex(w=>w.id===wallet.id);
    const expectedDebits=wallet.id===warm.id?30:wallet.id===hot.id?count:wallet.id===duplicateWallet.id?1:Math.floor(count/walletCount)+(distributedIndex<count%walletCount?1:0);
    checks.push({walletId:wallet.id,storedBalance:row.balance,ledgerBalance:row.calculated,debits:row.debits,expectedDebits,consistent:toCents(row.balance)===toCents(row.calculated)&&toCents(row.balance)===expected&&row.debits===expectedDebits});
  }
  const duplicateCheck=checks.find(c=>c.walletId===duplicateWallet.id)!;
  const [duplicateRows]=await db.query('SELECT count(*)::int AS n FROM (SELECT wallet_id,transaction_id FROM ledger WHERE wallet_id=ANY($1::uuid[]) GROUP BY wallet_id,transaction_id HAVING count(*)>1) duplicates',[wallets.map(w=>w.id)]);
  const report={runId,startedAt,finishedAt:new Date().toISOString(),environment,configuration:{urls,count,concurrency,walletCount,drainSeconds},methodology:'Closed-loop fixed requests, round-robin across APIs; 30 warmup requests excluded; hot wallet then distributed wallets then 50 duplicates. Client latency includes body parsing, failures and network. No target RPS; no coordinated-omission correction. Outbox SQL sampled every 1s, scoped to run wallets. API metric deltas sum all replicas. No CPU isolation.',warmup,results,
    outbox:{samples,peakPending:Math.max(...samples.map(s=>s.pending)),peakOldestPendingSeconds:Math.max(...samples.map(s=>s.oldestPendingSeconds)),finalPending:last.pending,drainElapsedSeconds:(performance.now()-loadEnded)/1000},
    correctness:{wallets:checks,duplicateLedgerRows:duplicateRows.n,duplicateScenarioDebits:duplicateCheck.debits,passed:checks.every(c=>c.consistent)&&duplicateRows.n===0&&duplicateCheck.debits===1}};
  await mkdir('reports',{recursive:true});const path=`reports/load-${startedAt.replaceAll(':','-')}.json`;await Bun.write(path,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:path,correctness:report.correctness.passed,finalOutboxPending:last.pending}));
  if(!report.correctness.passed || results.some(r=>r.errors>0) || last.pending>0)process.exitCode=1;
} finally {stopSampling=true;await sampling;await db.destroy();}
