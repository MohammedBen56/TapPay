import * as SQLite from 'expo-sqlite';

/**
 * Local persistence for Mode C (offline IOU) intents queued while both devices
 * are offline (M2). Plain expo-sqlite, deliberately WITHOUT field-level
 * encryption -- a scoped-down decision, not an oversight: the stored content
 * (a COSE-signed proposal) isn't a secret, its integrity comes from the
 * signature, not confidentiality, same sensitivity as what already rides
 * unencrypted inside an M1 QR code. Real at-rest encryption (SQLCipher via a
 * library like op-sqlite) is a named follow-up. See the M2 plan's gap #6.
 *
 * `device_seq`'s counter is NOT a security control -- the server never trusts
 * it, only `devices.last_seq` server-side matters (confirmed by how ADV-03 is
 * designed to pass even if this counter is freely manipulated). Its only job
 * is letting an honest, offline client pick an increasing seq without asking
 * the server, which is offline by construction in Mode C.
 */

export type LocalSyncStatus = 'PENDING' | 'SETTLED' | 'FAILED_INSUFFICIENT' | 'FAILED_EXPIRED' | 'FAILED_SEQUENCE_REGRESSION';

/** A Mode C payee's side: 'INCOMING' means only "the payer told me this is
 * coming" -- an unverified claim, not a cryptographic fact (the payee's phone
 * has no way to verify a signature made with the payer's identity key; only
 * the server can). 'SETTLED' is set ONLY after independently verifying a real
 * server-signed receipt for this tx_uuid, exactly like Mode B's payee already
 * does -- never on the incoming info alone. */
export type IncomingStatus = 'INCOMING' | 'SETTLED';

export interface IncomingIntent {
  txUuid: string;
  deviceId: string; // the payee's own device id -- which local queue this belongs to
  senderDeviceId: string;
  amount: string; // bigint as string, same reason as PendingIntent
  currency: string;
  createdAt: number;
  status: IncomingStatus;
  receipt: string | null; // base64, set only once independently verified
}

export interface PendingIntent {
  txUuid: string;
  deviceId: string;
  coseIou: string; // base64
  freshnessToken: string; // base64
  recipientDeviceId: string;
  amount: string; // bigint as string -- SQLite has no native bigint
  currency: string;
  seq: string; // bigint as string, same reason
  createdAt: number;
  syncStatus: LocalSyncStatus;
  syncedAt: number | null;
  receipt: string | null;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('tappay-offline.db').then(async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS offline_intents (
          tx_uuid TEXT PRIMARY KEY NOT NULL,
          device_id TEXT NOT NULL,
          cose_iou TEXT NOT NULL,
          freshness_token TEXT NOT NULL,
          recipient_device_id TEXT NOT NULL,
          amount TEXT NOT NULL,
          currency TEXT NOT NULL,
          seq TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          sync_status TEXT NOT NULL,
          synced_at INTEGER,
          receipt TEXT
        );
        CREATE TABLE IF NOT EXISTS device_seq (
          device_id TEXT PRIMARY KEY NOT NULL,
          next_seq TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS freshness_tokens (
          device_id TEXT PRIMARY KEY NOT NULL,
          token TEXT NOT NULL,
          issued_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS incoming_intents (
          tx_uuid TEXT PRIMARY KEY NOT NULL,
          device_id TEXT NOT NULL,
          sender_device_id TEXT NOT NULL,
          amount TEXT NOT NULL,
          currency TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          receipt TEXT
        );
        CREATE TABLE IF NOT EXISTS identity (
          email TEXT PRIMARY KEY NOT NULL,
          device_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          strongbox INTEGER NOT NULL
        );
      `);
      return db;
    });
  }
  return dbPromise!;
}

/** Read-and-increment the device's local sequence counter. Starts at 1 (0 is
 * devices.last_seq's server-side default -- the first real send must be
 * strictly greater than that). */
export async function getNextSeq(deviceId: string): Promise<bigint> {
  const db = await openDb();
  // withTransactionAsync's own return value is always void (its callback's
  // return isn't propagated) -- capture the result in an outer variable
  // instead of relying on the transaction call's own return.
  let seq = 0n;
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ next_seq: string }>(
      'SELECT next_seq FROM device_seq WHERE device_id = ?',
      deviceId,
    );
    seq = row ? BigInt(row.next_seq) : 1n;
    await db.runAsync(
      'INSERT INTO device_seq (device_id, next_seq) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET next_seq = ?',
      deviceId,
      (seq + 1n).toString(),
      (seq + 1n).toString(),
    );
  });
  return seq;
}

export async function insertPendingIntent(intent: {
  txUuid: string;
  deviceId: string;
  coseIou: string;
  freshnessToken: string;
  recipientDeviceId: string;
  amount: bigint;
  currency: string;
  seq: bigint;
}): Promise<void> {
  const db = await openDb();
  await db.runAsync(
    `INSERT INTO offline_intents
       (tx_uuid, device_id, cose_iou, freshness_token, recipient_device_id, amount, currency, seq, created_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    intent.txUuid,
    intent.deviceId,
    intent.coseIou,
    intent.freshnessToken,
    intent.recipientDeviceId,
    intent.amount.toString(),
    intent.currency,
    intent.seq.toString(),
    Date.now(),
  );
}

export async function listPendingIntents(deviceId: string): Promise<PendingIntent[]> {
  const db = await openDb();
  const rows = await db.getAllAsync<{
    tx_uuid: string;
    device_id: string;
    cose_iou: string;
    freshness_token: string;
    recipient_device_id: string;
    amount: string;
    currency: string;
    seq: string;
    created_at: number;
    sync_status: LocalSyncStatus;
    synced_at: number | null;
    receipt: string | null;
  }>('SELECT * FROM offline_intents WHERE device_id = ? AND sync_status = ? ORDER BY seq ASC', deviceId, 'PENDING');

  return rows.map((row) => ({
    txUuid: row.tx_uuid,
    deviceId: row.device_id,
    coseIou: row.cose_iou,
    freshnessToken: row.freshness_token,
    recipientDeviceId: row.recipient_device_id,
    amount: row.amount,
    currency: row.currency,
    seq: row.seq,
    createdAt: row.created_at,
    syncStatus: row.sync_status,
    syncedAt: row.synced_at,
    receipt: row.receipt,
  }));
}

/** Same shape as listPendingIntents but for on-screen display: no sync_status
 * filter, so SETTLED/FAILED_* rows stay visible instead of silently
 * disappearing the moment they leave PENDING. listPendingIntents stays
 * PENDING-only because it's also used to pick the /tx/sync batch -- keep the
 * two call sites separate rather than filtering client-side. */
export async function listRecentIntents(deviceId: string): Promise<PendingIntent[]> {
  const db = await openDb();
  const rows = await db.getAllAsync<{
    tx_uuid: string;
    device_id: string;
    cose_iou: string;
    freshness_token: string;
    recipient_device_id: string;
    amount: string;
    currency: string;
    seq: string;
    created_at: number;
    sync_status: LocalSyncStatus;
    synced_at: number | null;
    receipt: string | null;
  }>('SELECT * FROM offline_intents WHERE device_id = ? ORDER BY created_at DESC LIMIT 20', deviceId);

  return rows.map((row) => ({
    txUuid: row.tx_uuid,
    deviceId: row.device_id,
    coseIou: row.cose_iou,
    freshnessToken: row.freshness_token,
    recipientDeviceId: row.recipient_device_id,
    amount: row.amount,
    currency: row.currency,
    seq: row.seq,
    createdAt: row.created_at,
    syncStatus: row.sync_status,
    syncedAt: row.synced_at,
    receipt: row.receipt,
  }));
}

export async function markSyncResult(
  txUuid: string,
  status: LocalSyncStatus,
  receipt?: string,
): Promise<void> {
  const db = await openDb();
  await db.runAsync(
    'UPDATE offline_intents SET sync_status = ?, synced_at = ?, receipt = ? WHERE tx_uuid = ?',
    status,
    Date.now(),
    receipt ?? null,
    txUuid,
  );
}

export async function cacheFreshnessToken(deviceId: string, token: string, issuedAt: number): Promise<void> {
  const db = await openDb();
  await db.runAsync(
    'INSERT INTO freshness_tokens (device_id, token, issued_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET token = ?, issued_at = ?',
    deviceId,
    token,
    issuedAt,
    token,
    issuedAt,
  );
}

export async function getCachedFreshnessToken(deviceId: string): Promise<{ token: string; issuedAt: number } | null> {
  const db = await openDb();
  const row = await db.getFirstAsync<{ token: string; issued_at: number }>(
    'SELECT token, issued_at FROM freshness_tokens WHERE device_id = ?',
    deviceId,
  );
  return row ? { token: row.token, issuedAt: row.issued_at } : null;
}

export async function insertIncomingIntent(intent: {
  txUuid: string;
  deviceId: string;
  senderDeviceId: string;
  amount: bigint;
  currency: string;
}): Promise<void> {
  const db = await openDb();
  await db.runAsync(
    `INSERT OR IGNORE INTO incoming_intents
       (tx_uuid, device_id, sender_device_id, amount, currency, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'INCOMING')`,
    intent.txUuid,
    intent.deviceId,
    intent.senderDeviceId,
    intent.amount.toString(),
    intent.currency,
    Date.now(),
  );
}

export async function listIncomingIntents(deviceId: string): Promise<IncomingIntent[]> {
  const db = await openDb();
  const rows = await db.getAllAsync<{
    tx_uuid: string;
    device_id: string;
    sender_device_id: string;
    amount: string;
    currency: string;
    created_at: number;
    status: IncomingStatus;
    receipt: string | null;
  }>('SELECT * FROM incoming_intents WHERE device_id = ? ORDER BY created_at DESC', deviceId);

  return rows.map((row) => ({
    txUuid: row.tx_uuid,
    deviceId: row.device_id,
    senderDeviceId: row.sender_device_id,
    amount: row.amount,
    currency: row.currency,
    createdAt: row.created_at,
    status: row.status,
    receipt: row.receipt,
  }));
}

/** Only call this after independently verifying a real server-signed receipt
 * for this tx_uuid (verifyCoseSign1 against the pinned server key) -- never on
 * the strength of the incoming info alone. See IncomingStatus's doc comment. */
export async function markIncomingSettled(txUuid: string, receipt: string): Promise<void> {
  const db = await openDb();
  await db.runAsync(
    "UPDATE incoming_intents SET status = 'SETTLED', receipt = ? WHERE tx_uuid = ?",
    receipt,
    txUuid,
  );
}

/** Enrolled-identity cache, keyed by email (the same key /devices/enroll
 * itself uses to find-or-create an account). Without this, enrollDevice()
 * mints a fresh device_id on every call -- surviving only in React state --
 * and any app restart or screen switch orphans both offline_intents and
 * incoming_intents, since those are keyed by device_id. See identity.ts's
 * enrollDevice for the read-then-fall-back-to-real-enroll flow this backs. */
export async function getEnrolledIdentity(
  email: string,
): Promise<{ deviceId: string; accountId: string; strongBoxBacked: boolean } | null> {
  const db = await openDb();
  const row = await db.getFirstAsync<{ device_id: string; account_id: string; strongbox: number }>(
    'SELECT device_id, account_id, strongbox FROM identity WHERE email = ?',
    email,
  );
  return row ? { deviceId: row.device_id, accountId: row.account_id, strongBoxBacked: row.strongbox === 1 } : null;
}

export async function saveEnrolledIdentity(
  email: string,
  identity: { deviceId: string; accountId: string; strongBoxBacked: boolean },
): Promise<void> {
  const db = await openDb();
  await db.runAsync(
    `INSERT INTO identity (email, device_id, account_id, strongbox) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET device_id = ?, account_id = ?, strongbox = ?`,
    email,
    identity.deviceId,
    identity.accountId,
    identity.strongBoxBacked ? 1 : 0,
    identity.deviceId,
    identity.accountId,
    identity.strongBoxBacked ? 1 : 0,
  );
}
