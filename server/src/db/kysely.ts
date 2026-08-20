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

// DATE (oid 1082, first used by goals.target_date -- 026_goals.cjs) comes
// back from `pg` as a JS Date object by default, constructed at LOCAL
// midnight -- serializing it back out (Fastify's JSON reply calls
// Date.prototype.toJSON, i.e. toISOString) then re-expresses that instant
// in UTC, which silently shifts the calendar date backward by a day for
// any server timezone ahead of UTC. Found live: a goal saved with
// target_date "2027-06-01" came back as "2027-05-31T23:00:00.000Z" on a
// UTC+1 host. A DATE column here is never a timestamp -- it's an exact
// calendar day with no time-of-day meaning -- so the fix is the same
// "don't reinterpret through a lossy intermediate type" rule already
// applied to money above: return the raw `YYYY-MM-DD` string Postgres
// sends, verbatim.
pg.types.setTypeParser(1082, (value: string) => value);

// Mirrors the nil-UUID mint account inserted by migrations/001_accounts.cjs.
export const MINT_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

export type AccountType = "checking" | "savings";

/** Ship List v2 Phase 8 (022_users_table.cjs): a customer identity
 * (user_id/email/display_name, one per human) that email/display_name
 * used to live on directly, back when a customer could only ever have one
 * accounts row. See docs/adr/0011-users-table-extraction.md for why the
 * extraction was necessary, not just tidying. */
export interface UsersTable {
  user_id: string;
  email: string;
  display_name: string | null;
  created_at: Generated<Date>;
  /** Ship List v2 Wave 2 Phase 5 (025_round_up.cjs): opt-in round-up
   * savings preference. See server/src/roundup.ts. */
  round_up_enabled: Generated<boolean>;
}

export interface AccountsTable {
  account_id: Generated<string>;
  user_id: string;
  currency: Generated<string>;
  is_mint: Generated<boolean>;
  created_at: Generated<Date>;
  rib: string | null;
  /** Ship List v2 Phase 8: at most one 'checking' + one 'savings' per
   * user_id (accounts_user_id_account_type_key). Every account predating
   * this migration defaulted to 'checking'. */
  account_type: Generated<AccountType>;
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

/** Ship List v2 Wave 2 Phase 3 (023_settlement_events.cjs): an outbox
 * table for the IBankAdapter seam -- written by MockBankAdapter.transfer()
 * inside the same transaction as the journal/transfers writes. See the
 * migration's own comment for the full reasoning. */
export interface SettlementEventsTable {
  tx_uuid: string;
  from_account_id: string;
  to_account_id: string;
  amount: bigint;
  currency: string;
  created_at: Generated<Date>;
}

export type BillerCategory = "electricity" | "water" | "internet";

/** Bill payments (018_billers.cjs): a mock biller catalog. Each biller is
 * also an ordinary AccountsTable row (account_id here), exactly like the
 * mint account -- paying a bill is structurally a normal transfer. */
export interface BillersTable {
  id: Generated<string>;
  account_id: string;
  category: BillerCategory;
  name: string;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}

/** 019_bill_payments.cjs: one row per settled bill payment, written by the
 * route as a second statement after a successful bankAdapter.transfer()
 * call -- see that migration's own comment for why amount/currency aren't
 * duplicated here the way transfers duplicates journal's amount. */
export interface BillPaymentsTable {
  tx_uuid: string;
  account_id: string;
  biller_id: string;
  subscriber_reference: string;
  created_at: Generated<Date>;
}

/** Ship List v2 (021_audit_log.cjs): a request-level "who did what, when"
 * trail -- separate from and additional to journal/transfers, which
 * record what money moved. See the migration's own comment for why
 * user_id is nullable and why this exists alongside, not instead of,
 * logging.ts's deliberately PII-excluding request logger. */
export interface AuditLogTable {
  id: Generated<bigint>;
  user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip: string | null;
  created_at: Generated<Date>;
}

/** Ship List v2 Wave 2 Phase 4 (024_known_devices.cjs): a per-user login
 * fingerprint set, used to flag a login from a never-seen fingerprint
 * (audit_log's `login.new_device`) -- see
 * server/src/auth/deviceFingerprint.ts. Mutable (last_seen_at updates on
 * every repeat login), unlike journal/transfers/audit_log/
 * settlement_events. */
export interface KnownDevicesTable {
  user_id: string;
  fingerprint_hash: Buffer;
  first_seen_at: Generated<Date>;
  last_seen_at: Generated<Date>;
}

/** Ship List v2 Wave 2 Phase 5 (026_goals.cjs): a display/tracking layer
 * over money already sitting in the customer's ONE savings account --
 * deliberately not a real ledger sub-account. See the migration's own
 * comment for why, and server/src/routes/goals.ts for the fund/progress
 * logic. */
export interface GoalsTable {
  id: Generated<string>;
  owner_user_id: string;
  name: string;
  target_amount: bigint;
  saved_amount: Generated<bigint>;
  target_date: string | null;
  created_at: Generated<Date>;
}

/** Ship List v2 Wave 2 Phase 6 (027_support_requests.cjs): the in-app
 * support/FAQ contact form's stored half -- see server/src/routes/
 * support.ts. */
export type SupportRequestStatus = "open" | "resolved";
export interface SupportRequestsTable {
  id: Generated<string>;
  user_id: string;
  subject: string;
  message: string;
  status: Generated<SupportRequestStatus>;
  created_at: Generated<Date>;
}

/** Ship List v2 Wave 2 Phase 6 (028_disputes.cjs): "flag this transaction"
 * off the receipt screen -- see server/src/routes/disputes.ts. Never
 * touches money movement; a review request, not a reversal mechanism. */
export type DisputeStatus = "open" | "resolved";
export interface DisputesTable {
  id: Generated<string>;
  user_id: string;
  tx_uuid: string;
  reason: string;
  status: Generated<DisputeStatus>;
  created_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  accounts: AccountsTable;
  devices: DevicesTable;
  journal: JournalTable;
  reservations: ReservationsTable;
  offline_intents: OfflineIntentsTable;
  customer_credentials: CustomerCredentialsTable;
  auth_sessions: AuthSessionsTable;
  beneficiaries: BeneficiariesTable;
  transfers: TransfersTable;
  billers: BillersTable;
  bill_payments: BillPaymentsTable;
  audit_log: AuditLogTable;
  settlement_events: SettlementEventsTable;
  known_devices: KnownDevicesTable;
  goals: GoalsTable;
  support_requests: SupportRequestsTable;
  disputes: DisputesTable;
}

// Set by app.ts once Fastify's own logger exists (same pattern as
// redis.ts's setRedisLogger) -- undefined only in the brief window before
// app.ts runs, or for a script's own ad-hoc createDb() call that never
// wires one in, both covered by the console fallback below.
let dbLogger: { error: (obj: unknown, msg?: string) => void } | undefined;
export function setDbLogger(logger: { error: (obj: unknown, msg?: string) => void }): void {
  dbLogger = logger;
}

export function createDb(connectionString: string = config.appDatabaseUrl): Kysely<Database> {
  const pool = new pg.Pool({
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
  });

  // node-postgres's own documented gotcha, found here by direct
  // reproduction (a real `docker compose kill -s SIGKILL db` during the
  // Ship List Phase 3 chaos experiment): a Pool with no 'error' listener
  // crashes the ENTIRE process the moment a backgrounded/idle client hits a
  // connection-level error (exactly what killing Postgres produces on every
  // idle pooled connection at once) -- Node's default behavior for an
  // unhandled EventEmitter 'error' event is to throw, which closeWithGrace
  // (index.ts) then correctly treats as fatal and shuts the whole server
  // down for what was actually a transient, automatically-recoverable
  // outage. pg.Pool already reconnects lazily on the next query once
  // Postgres is back -- the ONLY thing missing was something to catch this
  // event instead of letting it become an uncaught exception.
  pool.on("error", (err: Error) => {
    (dbLogger ?? console).error(err, "postgres pool error (idle/background client) -- pool will reconnect lazily on next use");
  });

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export const db = createDb();
