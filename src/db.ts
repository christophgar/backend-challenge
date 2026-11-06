import 'reflect-metadata';
import { DataSource, EntitySchema } from 'typeorm';
import { Initial1793920000000 } from './migrations/initial';
import { LedgerIndex1793920000001 } from './migrations/ledger-index';

export const WalletRecord = new EntitySchema({
  name: 'WalletRecord', tableName: 'wallets', columns: {
    id: {type:'uuid',primary:true}, playerId: {name:'player_id',type:'uuid'},
    currency: {type:'text'}, balance: {type:'numeric'}, version: {type:'integer'},
    createdAt: {name:'created_at',type:'timestamptz'}, updatedAt: {name:'updated_at',type:'timestamptz'},
  },
});
export function createDataSource(url:string) { return new DataSource({
  type: 'postgres', url,
  entities: [WalletRecord], migrations: [Initial1793920000000,LedgerIndex1793920000001], synchronize: false,
  extra: { max: 20, connectionTimeoutMillis: 5000, statement_timeout: 15000,application_name:process.env.APP_NAME ?? 'wagering' },
}); }
export const db=createDataSource(process.env.DATABASE_URL ?? 'postgres://wagering_app:local_app_only@localhost:55432/wagering');
