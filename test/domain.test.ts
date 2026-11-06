import { test, expect } from 'bun:test';
import { Money } from '../src/domain/money';
import { Wallet, WagerTransaction } from '../src/domain/model';
import { canonical, hash, requestSchema } from '../src/contracts';
test('wallet rejects negative opening, zero movements and currency mismatch without mutation',()=>{
  const amount=Money.from({amount:'1.00',currency:'BRL'});
  expect(()=>Wallet.open('w','p',amount.negate())).toThrow();
  const wallet=Wallet.open('w','p',amount);
  expect(()=>wallet.move('t','CREDIT',Money.zero('BRL'))).toThrow();
  expect(()=>wallet.move('t','DEBIT',Money.from({amount:'1.00',currency:'USD'}))).toThrow('CURRENCY_MISMATCH');
  expect(wallet.balance.equals(amount)).toBe(true); expect(wallet.version).toBe(1);
  wallet.move('t','DEBIT',amount); expect(wallet.balance.isZero()).toBe(true); expect(wallet.version).toBe(2);
  wallet.move('t2','CREDIT',amount); expect(wallet.balance.equals(amount)).toBe(true); expect(wallet.version).toBe(3);
});
test.each(['BET','WIN','LOSS','REFUND','ROLLBACK'] as const)('%s validates its public contract',kind=>{
  const base={providerId:'p',externalTransactionId:'t',playerId:crypto.randomUUID(),walletId:crypto.randomUUID(),roundId:'r',gameId:'g',kind,
    money:{amount:kind==='LOSS'?'0.00':'1.00',currency:'BRL'},...(['REFUND','ROLLBACK'].includes(kind)?{referenceExternalTransactionId:'bet'}:{})};
  expect(requestSchema.safeParse(base).success).toBe(true);
  if(kind==='REFUND' || kind==='ROLLBACK') expect(requestSchema.safeParse({...base,referenceExternalTransactionId:undefined}).success).toBe(false);
  expect(requestSchema.safeParse({...base,money:{amount:kind==='LOSS'?'1.00':'0.00',currency:'BRL'}}).success).toBe(false);
});
test('wallet mutations produce balanced immutable ledger entries',()=>{
  const wallet=Wallet.open('wallet','player',Money.from({amount:'100.00',currency:'BRL'}));
  const entry=wallet.move('bet','DEBIT',Money.from({amount:'80.00',currency:'BRL'}));
  expect(entry.isBalanced()).toBe(true); expect(Object.isFrozen(entry)).toBe(true);
  expect(wallet.balance.toString()).toBe('20.00'); expect(wallet.version).toBe(2);
  expect(()=>wallet.move('bet2','DEBIT',Money.from({amount:'80.00',currency:'BRL'}))).toThrow();
  expect(wallet.balance.toString()).toBe('20.00');
});
test('terminal transaction transitions fail',()=>{
  for(const status of ['PROCESSED','REJECTED','FAILED'] as const) {
    const tx=WagerTransaction.rehydrate(status); expect(()=>tx.markProcessed()).toThrow('INVALID_TRANSACTION_STATE');
    expect(()=>tx.markPendingReference()).toThrow();
  }
});
test('canonical hash sorts nested keys',()=>{
  expect(hash({b:{z:1,a:2},a:3})).toBe(hash({a:3,b:{a:2,z:1}}));
  expect(hash({a:3})).not.toBe(hash({a:4}));
});
