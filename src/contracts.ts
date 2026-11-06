import { z } from 'zod';
import { createHash } from 'node:crypto';

export const moneySchema = z.object({
  amount: z.string().regex(/^(0|[1-9]\d{0,15})\.\d{2}$/),
  currency: z.enum(['BRL', 'USD', 'EUR']),
}).strict();
const text = z.string().min(1).max(200);
export const requestSchema = z.object({
  providerId: text, externalTransactionId: text, playerId: z.uuid(), walletId: z.uuid(),
  roundId: text, gameId: text, kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: moneySchema, referenceExternalTransactionId: text.optional(),
}).strict().superRefine((value, ctx) => {
  if (['REFUND', 'ROLLBACK'].includes(value.kind) && !value.referenceExternalTransactionId)
    ctx.addIssue({ code: 'custom', message: 'REFERENCE_REQUIRED' });
  if (value.kind !== 'LOSS' && value.money.amount === '0.00')
    ctx.addIssue({ code: 'custom', message: 'POSITIVE_AMOUNT_REQUIRED' });
  if (value.kind === 'LOSS' && value.money.amount !== '0.00')
    ctx.addIssue({ code: 'custom', message: 'LOSS_AMOUNT_MUST_BE_ZERO' });
  if (value.kind === 'BET' && value.referenceExternalTransactionId)
    ctx.addIssue({ code: 'custom', message: 'BET_REFERENCE_NOT_ALLOWED' });
});
export type Request = z.infer<typeof requestSchema>;
export const walletSchema = z.object({ playerId: z.uuid(), initialBalance: moneySchema }).strict();
export const keySchema = text;
export const envelopeSchema = z.object({
  messageId: text, type: z.literal('WagerTransactionRequested'), occurredAt: z.iso.datetime(),
  data: z.object({ idempotencyKey: text }).passthrough(),
}).strict();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export class AppError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number) { super(code); }
}
