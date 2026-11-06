import {test,expect,spyOn} from 'bun:test';
import {log,withLogContext,enrichLogContext,type LogFields} from '../src/observability';

test('logger drops unapproved fields, nested payloads and error details',()=>{
  const spy=spyOn(console,'log').mockImplementation(()=>{});
  try {
    const secret='super-secret@example.com';
    log('request_failed',{password:secret,token:secret,authorization:secret,payload:{amount:'987.65',balance:'123.45'},error:new Error(secret),errorType:secret,status:secret,loop:secret,httpStatus:503,providerId:secret} as unknown as LogFields);
    const line=String(spy.mock.calls[0]![0]);const row=JSON.parse(line);
    for(const forbidden of [secret,'987.65','123.45','password','authorization','stack'])expect(line).not.toContain(forbidden);
    expect(row.errorType).toBe('Error');expect(row.httpStatus).toBe(503);expect(row.providerId).toMatch(/^hmac:[a-f0-9]{64}$/);
    expect(row.status).toBeUndefined();expect(row.loop).toBeUndefined();
  } finally {spy.mockRestore();}
});
test('all identifiers are pseudonymized including UUIDs, and injection cannot create log lines',()=>{
  const spy=spyOn(console,'log').mockImplementation(()=>{});
  try {
    const value='user@example.com\n{"event":"forged"}';
    log('transaction_committed',{correlationId:value,messageId:value,transactionId:value,walletId:value,providerId:value,status:'PROCESSED'});
    log('transaction_committed',{correlationId:value});
    const line=String(spy.mock.calls[0]![0]),row=JSON.parse(line);
    expect(line).not.toContain('user@example.com');expect(line).not.toContain('\n');
    for(const key of ['correlationId','messageId','transactionId','walletId','providerId'])expect(row[key]).toMatch(/^hmac:[a-f0-9]{64}$/);
    expect(row.correlationId).toBe(JSON.parse(String(spy.mock.calls[1]![0])).correlationId);
  } finally {spy.mockRestore();}
});
test('unknown events, non-string IDs and oversized IDs cannot leak arbitrary values',()=>{
  const spy=spyOn(console,'log').mockImplementation(()=>{});
  try {
    log('secret@example.com' as never,{walletId:{toJSON(){throw new Error('must not serialize');}},messageId:'x'.repeat(513)} as unknown as LogFields);
    const row=JSON.parse(String(spy.mock.calls[0]![0]));expect(row.event).toBe('invalid_log_event');expect(row.walletId).toBeNull();expect(row.messageId).toBeNull();
  } finally {spy.mockRestore();}
});
test('concurrent contexts preserve error correlation without leaking another operation',async()=>{
  const spy=spyOn(console,'log').mockImplementation(()=>{});
  try {
    await Promise.all(['one','two'].map((id,index)=>withLogContext({correlationId:id,walletId:id},async()=>{
      enrichLogContext({transactionId:id});await Bun.sleep(index===0?10:1);log('message_failed',{errorType:'QueryFailedError'});
    })));
    const rows=spy.mock.calls.map(c=>JSON.parse(String(c[0])));
    expect(rows).toHaveLength(2);expect(rows[0].correlationId).not.toBe(rows[1].correlationId);
    for(const row of rows){expect(row.correlationId).toBe(row.walletId);expect(row.transactionId).toBe(row.walletId);}
    log('worker_iteration_failed');const outside=JSON.parse(String(spy.mock.calls[2]![0]));expect(outside.walletId).toBeNull();
  } finally {spy.mockRestore();}
});
test.each(['src/main.ts','src/worker.ts'])('%s startup failure does not expose connection credentials',async path=>{
  const secret='secret-credential-for-log-test';
  const child=Bun.spawn(['bun',path],{env:{...process.env,DATABASE_URL:`postgres://logtest:${secret}@127.0.0.1:1/wagering`},stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(code).toBe(1);expect(stdout+stderr).not.toContain(secret);expect(stdout+stderr).not.toContain('postgres://');
  const row=JSON.parse(stdout.trim());expect(row.event).toBe('startup_failed');expect(row.correlationId).toMatch(/^hmac:/);
},10000);
