import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
describe('Money', () => {
  test('fixed scale, comparisons, zero and negation remain exact',()=>{
    expect(Money.zero('BRL').toJSON()).toEqual({amount:'0.00',currency:'BRL'});
    expect(brl('0.01').negate().toString()).toBe('-0.01');
    expect(brl('0.01').negate().negate().equals(brl('0.01'))).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isLessThan(brl('0.02'))).toBe(true);
    expect(brl('999.99').add(brl('0.01')).toString()).toBe('1000.00');
  });
  test.each(['1.005','1.004','1.999','0.000','1.0','+1.00','1,00','0x10','1.00 '])('rejects %s rather than implicitly rounding',amount=>{
    expect(()=>brl(amount)).toThrow('INVALID_MONEY_AMOUNT');
  });
  test('rejects non-string monetary input',()=>{
    for(const amount of [1,NaN,Infinity,null,undefined,{},[]]) expect(()=>Money.from({amount:amount as string,currency:'BRL'})).toThrow();
  });
  test('every binary operation rejects mixed currencies',()=>{
    const a=brl('1.00'),b=Money.from({amount:'1.00',currency:'USD'});
    for(const operation of ['add','subtract','equals','isLessThan'] as const) expect(()=>a[operation](b)).toThrow('CURRENCY_MISMATCH');
  });
  test('preserves precision beyond safe integer and leaves operands unchanged', () => {
    const original = brl('9007199254740993.99');
    expect(original.add(brl('0.01')).toString()).toBe('9007199254740994.00');
    expect(original.toString()).toBe('9007199254740993.99');
  });
  test.each(['NaN', 'Infinity', '', '1e2', '-1.00', '1.001', ' 1.00', '1', '01.00'])('rejects %s', value => {
    expect(() => brl(value)).toThrow('INVALID_MONEY_AMOUNT');
  });
  test('supports exact signed internal arithmetic', () => {
    expect(brl('0.10').subtract(brl('0.30')).toString()).toBe('-0.20');
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });
  test('rejects currency mismatch', () => {
    expect(() => brl('1.00').add(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow('CURRENCY_MISMATCH');
  });
});
