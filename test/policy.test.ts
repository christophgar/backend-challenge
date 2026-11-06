import { test,expect } from 'bun:test';
import { decide,decideIdentity,type Operation,type Reference } from '../src/domain/policy';
import { Money } from '../src/domain/money';
const money=(amount='80.00',currency='BRL')=>Money.from({amount,currency});
const operation=(kind:Operation['kind']='BET'):Operation=>({providerId:'provider',playerId:'player',walletId:'wallet',roundId:'round',kind,money:money(kind==='LOSS'?'0.00':'80.00'),...(['REFUND','ROLLBACK'].includes(kind)?{referenceExternalTransactionId:'bet'}:{})});
const reference=(kind='BET'):Reference=>({...operation(),kind,status:'PROCESSED'});
function evaluate(o:Operation=operation(),r?:Reference,extra:Partial<Parameters<typeof decide>[0]>={}) {
  return decide({operation:o,wallet:{playerId:'player',balance:money('100.00')},reference:r,alreadyReversed:false,attempts:0,ageMs:0,...extra});
}
test.each(['BET','WIN','LOSS','REFUND','ROLLBACK'] as const)('%s produces the financial direction required by the business',kind=>{
  expect(evaluate(operation(kind),['REFUND','ROLLBACK'].includes(kind)?reference():undefined)).toEqual({status:'PROCESSED',direction:kind==='LOSS'?null:kind==='BET'?'DEBIT':'CREDIT'});
});
test.each(['BET','WIN','REFUND'])('ROLLBACK inverts %s',kind=>{
  expect(evaluate(operation('ROLLBACK'),reference(kind))).toEqual({status:'PROCESSED',direction:kind==='BET'?'CREDIT':'DEBIT'});
});
test('BET rejects insufficient funds but permits exact available balance',()=>{
  expect(evaluate(operation(),undefined,{wallet:{playerId:'player',balance:money('79.99')}})).toEqual({status:'REJECTED',failureCode:'INSUFFICIENT_FUNDS'});
  expect(evaluate(operation(),undefined,{wallet:{playerId:'player',balance:money()}}).status).toBe('PROCESSED');
});
test('rollback has a distinct insufficient funds failure',()=>{
  expect(evaluate(operation('ROLLBACK'),reference('WIN'),{wallet:{playerId:'player',balance:money('0.00')}})).toEqual({status:'REJECTED',failureCode:'REVERSAL_INSUFFICIENT_FUNDS'});
});
test.each(['REFUND','ROLLBACK'] as const)('%s requires full, unique reversal',kind=>{
  expect(evaluate({...operation(kind),referenceExternalTransactionId:undefined})).toEqual({status:'REJECTED',failureCode:'REFERENCE_REQUIRED'});
  expect(evaluate({...operation(kind),money:money('79.99')},reference())).toEqual({status:'REJECTED',failureCode:'REFERENCE_AMOUNT_MISMATCH'});
  expect(evaluate(operation(kind),reference(),{alreadyReversed:true})).toEqual({status:'REJECTED',failureCode:'ALREADY_REVERSED'});
});
test.each(['providerId','playerId','walletId','roundId'] as const)('reference must share %s',field=>{
  expect(evaluate(operation('REFUND'),{...reference(),[field]:'another'})).toEqual({status:'REJECTED',failureCode:'REFERENCE_SCOPE_MISMATCH'});
});
test('wallet and reference currency conflicts are distinguished',()=>{
  expect(evaluate({...operation(),money:money('80.00','USD')})).toEqual({status:'REJECTED',failureCode:'CURRENCY_MISMATCH'});
  expect(evaluate(operation('REFUND'),{...reference(),money:money('80.00','USD')})).toEqual({status:'REJECTED',failureCode:'REFERENCE_SCOPE_MISMATCH'});
});
test.each(['REJECTED','FAILED'] as const)('cannot reverse a %s reference',status=>{
  expect(evaluate(operation('REFUND'),{...reference(),status})).toEqual({status:'REJECTED',failureCode:'REFERENCE_NOT_PROCESSED'});
});
test.each(['WIN','LOSS','REFUND','ROLLBACK','OPENING'])('REFUND rejects reference kind %s',kind=>{
  expect(evaluate(operation('REFUND'),reference(kind))).toEqual({status:'REJECTED',failureCode:'REFERENCE_KIND_INVALID'});
});
test.each(['LOSS','ROLLBACK','OPENING'])('ROLLBACK rejects reference kind %s',kind=>{
  expect(evaluate(operation('ROLLBACK'),reference(kind))).toEqual({status:'REJECTED',failureCode:'REFERENCE_KIND_INVALID'});
});
test.each(['WIN','LOSS'] as const)('%s optionally references only BET',kind=>{
  const o={...operation(kind),referenceExternalTransactionId:'bet'};
  expect(evaluate(o,reference()).status).toBe('PROCESSED');
  expect(evaluate(o,reference('WIN'))).toEqual({status:'REJECTED',failureCode:'REFERENCE_KIND_INVALID'});
});
test('missing or unfinished references wait, then reject at configured boundaries',()=>{
  for(const r of [undefined,{...reference(),status:'PENDING' as const},{...reference(),status:'PENDING_REFERENCE' as const}]) {
    expect(evaluate(operation('REFUND'),r,{attempts:15,ageMs:86400000})).toEqual({status:'PENDING_REFERENCE'});
    expect(evaluate(operation('REFUND'),r,{attempts:16})).toEqual({status:'REJECTED',failureCode:'REFERENCE_NOT_FOUND'});
    expect(evaluate(operation('REFUND'),r,{ageMs:86400001})).toEqual({status:'REJECTED',failureCode:'REFERENCE_NOT_FOUND'});
  }
});
test('resolved reference proceeds even after waiting, without changing input values',()=>{
  const o=operation('REFUND'),r=reference();
  expect(evaluate(o,r,{attempts:16,ageMs:86400001}).status).toBe('PROCESSED');
  expect(o.money.toString()).toBe('80.00'); expect(r.status).toBe('PROCESSED');
});
test('credit overflow and player mismatch reject before balance mutation',()=>{
  expect(evaluate(operation('WIN'),undefined,{wallet:{playerId:'player',balance:money('9999999999999999.99')}})).toEqual({status:'REJECTED',failureCode:'BALANCE_LIMIT_EXCEEDED'});
  expect(evaluate({...operation(),playerId:'wrong'})).toEqual({status:'REJECTED',failureCode:'PLAYER_MISMATCH'});
});
test('idempotency distinguishes new, identical, divergent and conflicting identities',()=>{
  const stored={key:'key',payloadHash:'original',status:'PROCESSED' as const};
  expect(decideIdentity('key','original',[])).toBe('NEW');
  expect(decideIdentity('key','original',[stored])).toBe('REPLAY');
  expect(decideIdentity('key','different',[stored])).toBe('IDEMPOTENCY_CONFLICT');
  expect(decideIdentity('other-key','original',[stored])).toBe('EXTERNAL_ID_CONFLICT');
  expect(decideIdentity('key','original',[stored,stored])).toBe('IDEMPOTENCY_CONFLICT');
});
test('only pending reference can be reprocessed; terminal states always replay',()=>{
  for(const status of ['PROCESSED','REJECTED','FAILED','PENDING'] as const)
    expect(decideIdentity('k','h',[{key:'k',payloadHash:'h',status}],true)).toBe('REPLAY');
  const pending={key:'k',payloadHash:'h',status:'PENDING_REFERENCE' as const};
  expect(decideIdentity('k','h',[pending])).toBe('REPLAY');
  expect(decideIdentity('k','h',[pending],true)).toBe('REPROCESS');
  expect(decideIdentity('k','different',[pending],true)).toBe('IDEMPOTENCY_CONFLICT');
});
