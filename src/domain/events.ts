export abstract class IntegrationEvent {
  abstract readonly eventType: string;
  readonly version = 1;
  readonly eventId = crypto.randomUUID();
  readonly occurredAt = new Date().toISOString();
  constructor(public readonly aggregateId: string, public readonly correlationId: string,
    public readonly data: Readonly<Record<string, unknown>>, public readonly causationId?: string) {}
  toJSON() { return { eventId: this.eventId, eventType: this.eventType, version: this.version,
    occurredAt: this.occurredAt, aggregateId: this.aggregateId, correlationId: this.correlationId,
    causationId: this.causationId, data: this.data }; }
}
export class WagerTransactionProcessed extends IntegrationEvent { readonly eventType = 'WagerTransactionProcessed'; }
export class WagerTransactionRejected extends IntegrationEvent { readonly eventType = 'WagerTransactionRejected'; }
export class WagerTransactionFailed extends IntegrationEvent { readonly eventType = 'WagerTransactionFailed'; }
export class WagerTransactionPendingReference extends IntegrationEvent { readonly eventType = 'WagerTransactionPendingReference'; }
export class WalletBalanceChanged extends IntegrationEvent { readonly eventType = 'WalletBalanceChanged'; }
