import type { MigrationInterface,QueryRunner } from 'typeorm';
export class LedgerIndex1793920000001 implements MigrationInterface {
  async up(q:QueryRunner) { await q.query('CREATE INDEX ledger_transaction_lookup ON ledger(transaction_id)'); }
  async down(q:QueryRunner) { await q.query('DROP INDEX ledger_transaction_lookup'); }
}
