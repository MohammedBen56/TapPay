import { Kysely, PostgresDialect, type Generated } from "kysely";
import pg from "pg";

// BIGINT (oid 20) comes back as a JS string by default; register bigint parsing
// once, globally, before any query runs. This is the load-bearing line that makes
// "money is bigint, never float" actually true at the DB boundary -- without it,
// every journal/reservation amount read from Postgres would silently be a string.
pg.types.setTypeParser(20, BigInt);

// Mirrors the nil-UUID mint account inserted by migrations/001_accounts.cjs.
export const MINT_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

export interface AccountsTable {
  account_id: Generated<string>;
  user_id: string;
  email: string;
  currency: Generated<string>;
  is_mint: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface DevicesTable {
  device_id: Buffer;
  user_id: string;
  identity_pubkey: Buffer;
  platform: "android" | "ios";
  attestation_blob: unknown;
  attestation_ok: Generated<boolean>;
  last_seq: Generated<bigint>;
  enrolled_at: Generated<Date>;
}

export interface JournalTable {
  id: Generated<bigint>;
  tx_uuid: string;
  account_id: string;
  amount: bigint;
  currency: string;
  created_at: Generated<Date>;
}

export type ReservationState = "HELD" | "COMMITTED" | "RELEASED";

export interface ReservationsTable {
  tx_uuid: string;
  account_id: string;
  amount: bigint;
  expires_at: Date;
  state: ReservationState;
  created_at: Generated<Date>;
}

export type OfflineIntentStatus = "PENDING" | "SETTLED" | "FAILED_INSUFFICIENT" | "FAILED_EXPIRED";

export interface OfflineIntentsTable {
  tx_uuid: string;
  sender_id: string;
  receiver_id: string;
  amount: bigint;
  currency: string;
  cose_proposal: Buffer;
  status: OfflineIntentStatus;
  synced_at: Generated<Date>;
}

export interface Database {
  accounts: AccountsTable;
  devices: DevicesTable;
  journal: JournalTable;
  reservations: ReservationsTable;
  offline_intents: OfflineIntentsTable;
}

export function createDb(connectionString: string = process.env.DATABASE_URL!): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString }),
    }),
  });
}

export const db = createDb();
