import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Initial1793920000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> { await q.query(`
    CREATE TABLE wallets (
      id uuid PRIMARY KEY, player_id uuid NOT NULL, currency text NOT NULL CHECK(currency IN ('BRL','USD','EUR')),
      balance numeric NOT NULL CHECK(balance >= 0 AND balance < 10000000000000000 AND scale(balance) <= 2),
      version integer NOT NULL DEFAULT 1 CHECK(version >= 1), created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(player_id,currency), UNIQUE(id,currency)
    );
    CREATE TABLE transactions (
      id uuid PRIMARY KEY, provider_id text NOT NULL, external_id text NOT NULL,
      idempotency_key text NOT NULL UNIQUE, payload_hash text NOT NULL,
      wallet_id uuid NOT NULL REFERENCES wallets(id), kind text NOT NULL CHECK(kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
      status text NOT NULL CHECK(status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
      request jsonb NOT NULL, result jsonb, reference_id uuid REFERENCES transactions(id),
      attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
      UNIQUE(provider_id,external_id), UNIQUE(id,wallet_id)
    );
    CREATE UNIQUE INDEX one_reversal ON transactions(reference_id,kind) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK');
    CREATE INDEX pending_reference_due ON transactions(next_attempt_at) WHERE status='PENDING_REFERENCE';
    CREATE TABLE ledger (
      sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id uuid NOT NULL UNIQUE, wallet_id uuid NOT NULL, transaction_id uuid NOT NULL,
      currency text NOT NULL, direction text NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
      amount numeric NOT NULL CHECK(amount > 0 AND scale(amount)<=2),
      balance_before numeric NOT NULL CHECK(balance_before>=0 AND scale(balance_before)<=2),
      balance_after numeric NOT NULL CHECK(balance_after>=0 AND scale(balance_after)<=2),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(wallet_id,currency) REFERENCES wallets(id,currency),
      FOREIGN KEY(transaction_id,wallet_id) REFERENCES transactions(id,wallet_id),
      UNIQUE(wallet_id,transaction_id),
      CHECK(balance_after = balance_before + CASE WHEN direction='CREDIT' THEN amount ELSE -amount END)
    );
    CREATE INDEX ledger_cursor ON ledger(wallet_id,sequence);
    CREATE TABLE inbox (
      consumer_name text NOT NULL, message_id text NOT NULL, payload_hash text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
      PRIMARY KEY(consumer_name,message_id)
    );
    CREATE TABLE outbox (
      id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, payload jsonb NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
    );
    CREATE INDEX outbox_due ON outbox(next_attempt_at,occurred_at) WHERE published_at IS NULL;
    CREATE FUNCTION immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'IMMUTABLE_LEDGER' USING ERRCODE='23514'; END $$;
    CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger FOR EACH STATEMENT EXECUTE FUNCTION immutable_ledger();
    CREATE FUNCTION terminal_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
        RAISE EXCEPTION 'TERMINAL_TRANSACTION' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER terminal_transaction BEFORE UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION terminal_transaction();
    CREATE FUNCTION wallet_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.currency <> OLD.currency OR NEW.player_id <> OLD.player_id OR
        NEW.version <> OLD.version + (CASE WHEN NEW.balance <> OLD.balance THEN 1 ELSE 0 END) THEN
        RAISE EXCEPTION 'INVALID_WALLET_TRANSITION' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER wallet_version BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION wallet_version();
    CREATE FUNCTION check_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE wid uuid; actual numeric; calculated numeric;
      BEGIN
        IF TG_TABLE_NAME='wallets' THEN wid:=NEW.id; ELSE wid:=NEW.wallet_id; END IF;
        SELECT balance INTO actual FROM wallets WHERE id=wid FOR UPDATE;
        SELECT coalesce(sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0) INTO calculated FROM ledger WHERE wallet_id=wid;
        IF actual <> calculated THEN RAISE EXCEPTION 'BALANCE_LEDGER_MISMATCH' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END $$;
    CREATE CONSTRAINT TRIGGER wallet_ledger_consistent AFTER INSERT OR UPDATE ON wallets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
    CREATE CONSTRAINT TRIGGER ledger_wallet_consistent AFTER INSERT ON ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
    CREATE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE tid uuid; t transactions; n integer;
      BEGIN
        IF TG_TABLE_NAME='transactions' THEN tid:=NEW.id; ELSE tid:=NEW.transaction_id; END IF;
        SELECT * INTO t FROM transactions WHERE id=tid;
        SELECT count(*) INTO n FROM ledger WHERE transaction_id=tid;
        IF (t.status='PROCESSED' AND t.kind<>'LOSS' AND n<>1) OR
           ((t.status<>'PROCESSED' OR t.kind='LOSS') AND n<>0) THEN
           RAISE EXCEPTION 'TRANSACTION_LEDGER_MISMATCH' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END $$;
    CREATE CONSTRAINT TRIGGER transaction_ledger_consistent AFTER INSERT OR UPDATE ON transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
    CREATE CONSTRAINT TRIGGER ledger_transaction_consistent AFTER INSERT ON ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
  `); }
  async down(q: QueryRunner): Promise<void> { await q.query(`
    DROP TABLE outbox,inbox,ledger,transactions,wallets CASCADE;
    DROP FUNCTION check_transaction_ledger(),check_wallet_ledger(),wallet_version(),terminal_transaction(),immutable_ledger();
  `); }
}
