import { createDataSource } from './db';
const db=createDataSource(process.env.MIGRATION_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:55432/wagering');
await db.initialize();
try {
  if (process.argv.includes('--down')) await db.undoLastMigration();
  else {
    await db.runMigrations({ transaction: 'all' });
    if(process.env.PROVISION_LOCAL_ROLE==='1' || (!process.env.MIGRATION_DATABASE_URL && process.env.PROVISION_LOCAL_ROLE!=='0')) {
      // Local Compose only; production roles/secrets must be provisioned separately.
      await db.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wagering_app') THEN
        CREATE ROLE wagering_app LOGIN PASSWORD 'local_app_only' NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT USAGE ON SCHEMA public TO wagering_app;
        GRANT SELECT,INSERT,UPDATE ON wallets,transactions,inbox,outbox TO wagering_app;
        GRANT SELECT,INSERT ON ledger TO wagering_app;
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO wagering_app;`);
    }
  }
} finally { await db.destroy(); }
