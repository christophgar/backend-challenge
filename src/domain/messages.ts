export class InboxMessage {
  private constructor(public readonly messageId:string,public readonly consumerName:string,
    public readonly payloadHash:string,private _processedAt?:Date) {}
  static receive(messageId:string,consumerName:string,payloadHash:string) { return new InboxMessage(messageId,consumerName,payloadHash); }
  static rehydrate(messageId:string,consumerName:string,payloadHash:string,processedAt?:Date) { return new InboxMessage(messageId,consumerName,payloadHash,processedAt); }
  get processedAt() { return this._processedAt; }
  isProcessed() { return this._processedAt!==undefined; }
  markProcessed(at:Date) { if(this.isProcessed()) throw new Error('INBOX_ALREADY_PROCESSED'); this._processedAt=at; }
}
export class OutboxMessage {
  private constructor(private _attempts:number,private _nextAttemptAt?:Date,private _publishedAt?:Date) {}
  static enqueue() { return new OutboxMessage(0); }
  static rehydrate(attempts:number,nextAttemptAt?:Date,publishedAt?:Date) { return new OutboxMessage(attempts,nextAttemptAt,publishedAt); }
  get attempts() { return this._attempts; }
  get nextAttemptAt() { return this._nextAttemptAt; }
  get publishedAt() { return this._publishedAt; }
  isPending() { return !this._publishedAt; }
  isDue(now:Date) { return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt<=now); }
  markPublished(now:Date) { if(!this.isPending()) throw new Error('OUTBOX_ALREADY_PUBLISHED'); this._publishedAt=now; this._attempts++; }
  scheduleRetry(now:Date) {
    if(!this.isPending()) throw new Error('OUTBOX_ALREADY_PUBLISHED');
    this._nextAttemptAt=new Date(now.getTime()+Math.min(3600,2 ** Math.min(this._attempts,12))*1000); this._attempts++;
  }
}
