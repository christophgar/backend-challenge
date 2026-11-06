import { Money } from './money';
export type Direction = 'DEBIT' | 'CREDIT';
export type Status = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

export class WalletLedgerEntry {
  private constructor(public readonly walletId: string, public readonly transactionId: string,
    public readonly direction: Direction, public readonly money: Money,
    public readonly balanceBefore: Money, public readonly balanceAfter: Money) { Object.freeze(this); }
  static create(walletId: string, transactionId: string, direction: Direction, money: Money, before: Money, after: Money) {
    const entry = new WalletLedgerEntry(walletId, transactionId, direction, money, before, after);
    if (!money.isPositive() || after.isNegative() || !entry.isBalanced()) throw new Error('INVALID_LEDGER');
    return entry;
  }
  static rehydrate(state: WalletLedgerEntry) {
    return new WalletLedgerEntry(state.walletId, state.transactionId, state.direction, state.money, state.balanceBefore, state.balanceAfter);
  }
  isBalanced(): boolean {
    return (this.direction === 'CREDIT' ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money)).equals(this.balanceAfter);
  }
}
export class Wallet {
  private constructor(public readonly id: string, public readonly playerId: string, private _balance: Money, private _version: number) {}
  static open(id: string, playerId: string, balance: Money) {
    if (balance.isNegative()) throw new Error('NEGATIVE_BALANCE');
    return new Wallet(id, playerId, balance, 1);
  }
  static rehydrate(id: string, playerId: string, balance: Money, version: number) { return new Wallet(id, playerId, balance, version); }
  get balance() { return this._balance; }
  get version() { return this._version; }
  move(transactionId: string, direction: Direction, money: Money): WalletLedgerEntry {
    const after = direction === 'CREDIT' ? this.balance.add(money) : this.balance.subtract(money);
    const entry = WalletLedgerEntry.create(this.id, transactionId, direction, money, this.balance, after);
    this._balance = after;
    this._version++;
    return entry;
  }
}
export class WagerTransaction {
  private constructor(private _status: Status, private _failureCode?: string) {}
  static create() { return new WagerTransaction('PENDING'); }
  static rehydrate(status: Status, failureCode?: string) { return new WagerTransaction(status, failureCode); }
  get status() { return this._status; }
  get failureCode() { return this._failureCode; }
  isTerminal() { return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status); }
  private transition(status: Status, code?: string) {
    if (this.isTerminal()) throw new Error('INVALID_TRANSACTION_STATE');
    this._status = status; this._failureCode = code;
  }
  markProcessed() { this.transition('PROCESSED'); }
  markPendingReference() { this.transition('PENDING_REFERENCE'); }
  reject(code: string) { this.transition('REJECTED', code); }
  fail(code: string) { this.transition('FAILED', code); }
}
