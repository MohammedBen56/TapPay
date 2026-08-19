import { Kysely, PostgresDialect, type Generated } from "kysely";
import pg from "pg";
import { config } from "../config.js";

// BIGINT (oid 20) comes back as a JS string by default; register bigint parsing
// once, globally, before any query runs. This is the load-bearing line that makes
// "money is bigint, never float" actually true at the DB boundary -- without it,
// every journal/reservation amount read from Postgres would silently be a string.
pg.types.setTypeParser(20, BigInt);
// SUM(bigint_column) returns NUMERIC (oid 1700), not bigint, to avoid silent
// overflow -- a different OID the line above does not cover. Every numeric-domain
// value in this schema is integer money (never a genuine decimal), so parsing it
// as BigInt here is the correct behavior, not a hack: it's what "no floats, no
// decimals-as-float" (CLAUDE.md §5) actually requires for balance aggregates.
pg.types.setTypeParser(1700, BigInt);

// Mirrors the nil-UUID mint account inserted by migrations/001_accounts.cjs.
export const MINT_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

export interface AccountsTable {
  account_id: Generated<string>;
  user_id: string;
  email: string;
  currency: Generated<string>;
  is_mint: Generated<boolean>;
  created_at: Generated<Date>;
  /** v2: nullable -- the seeded mint account (001_accounts.cjs) has neither. */
  display_name: string | null;
  rib: string | null;
}

export interface DevicesTable {
  device_id: Buffer;
  user_id: string;
  identity_pubkey: Buffer;
  platform: "android" | "ios";
  attestation_blob: unknown;
  attestation_ok: Generated<boolean>;
  last_seq: Generated<bigint>;
  /** Set by /tx/sync (M2) on the first detected sequence regression -- an audit
   * signal, not an automatic freeze. NULL means never flagged. */
  rollback_flagged_at: Date | null;
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
  currency: string;
  expires_at: Date;
  state: ReservationState;
  created_at: Generated<Date>;
  /** Populated on commit -- lets idempotent resubmission return the exact same
   * receipt bytes rather than a fresh (differently-randomized) signature. */
  receipt_signature: Buffer | null;
  settled_at: Date | null;
  /** NULL for a bare reserve() (no known destination); set internally by
   * transfer(). commit() needs this to know who the credit side of the journal
   * entry goes to -- see MockBankAdapter and migrations/007. */
  counterparty_account_id: string | null;
}

export type OfflineIntentStatus =
  | "PENDING"
  | "SETTLED"
  | "FAILED_INSUFFICIENT"
  | "FAILED_EXPIRED"
  | "FAILED_SEQUENCE_REGRESSION"
  | "FAILED_CONFLICT";

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

/** v2 auth (013_customer_credentials.cjs): a separate table from accounts so
 * the mint account never needs a fake password hash. */
export interface CustomerCredentialsTable {
  customer_id: string;
  user_id: string;
  password_hash: string;
  failed_attempts: Generated<number>;
  locked_until: Date | null;
  created_at: Generated<Date>;
}

/** v2 auth (014_auth_sessions.cjs): refresh tokens, stored as a hash only,
 * rotated on every use. See routes/auth.ts (M1c) for the rotation/revocation
 * logic that reads and writes this table. */
export interface AuthSessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: Buffer;
  family_id: string;
  issued_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

/** v2 Send flow (015_beneficiaries.cjs): stores the RIB, not a resolved
 * account_id -- a beneficiary is a typed bank coordinate, resolved at send
 * time. */
export interface BeneficiariesTable {
  id: Generated<string>;
  owner_user_id: string;
  display_name: string;
  rib: string;
  created_at: Generated<Date>;
}

/** v2 transfer metadata (016_transfers.cjs): one row per settled transfer,
 * carrying the human-readable reference -- kept off journal deliberately, see
 * the migration's own comment. */
export interface TransfersTable {
  tx_uuid: string;
  from_account_id: string;
  to_account_id: string;
  amount: bigint;
  currency: string;
  reference: string;
  created_at: Generated<Date>;
}

export interface Database {
  accounts: AccountsTable;
  devices: DevicesTable;
  journal: JournalTable;
  reservations: ReservationsTable;
  offline_intents: OfflineIntentsTable;
  customer_credentials: CustomerCredentialsTable;
  auth_sessions: AuthSessionsTable;
  beneficiaries: BeneficiariesTable;
  transfers: TransfersTable;
}

export function createDb(connectionString: string = config.appDatabaseUrl): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
        max: config.dbPoolMax,
        connectionTimeoutMillis: config.dbPoolConnectionTimeoutMs,
        idleTimeoutMillis: config.dbPoolIdleTimeoutMs,
        statement_timeout: config.dbStatementTimeoutMs,
        lock_timeout: config.dbLockTimeoutMs,
        idle_in_transaction_session_timeout: config.dbIdleInTransactionSessionTimeoutMs,
        // Distinguishes this pool from the sweeper/migrations/a raw psql
        // session in pg_stat_activity -- cheap, and it's the difference
        // between "something is hung" and "something is hung, and it's the
        // app pool, not the sweeper" when actually debugging it live.
        application_name: "tappay-server",
      }),
    }),
  });
}

export const db = createDb();
