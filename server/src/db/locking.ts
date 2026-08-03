import type { Transaction } from "kysely";
import type { Database } from "./kysely.js";

export class UnknownAccountError extends Error {
  constructor(accountId: string) {
    super(`unknown account: ${accountId}`);
    this.name = "UnknownAccountError";
  }
}

/**
 * Locks one account row (SELECT ... FOR UPDATE) -- the serialization point for
 * every balance-affecting operation. Must run inside an open transaction.
 *
 * Locking journal rows (an earlier draft of this) does NOT serialize concurrent
 * reserve/transfer calls: it only locks rows that already exist, so two concurrent
 * calls can both read the same available-balance snapshot before either insert is
 * visible -- a phantom-read race that allows overdraft. The accounts row is the
 * actual serialization point.
 */
export async function lockAccount(trx: Transaction<Database>, accountId: string): Promise<void> {
  const row = await trx
    .selectFrom("accounts")
    .select("account_id")
    .where("account_id", "=", accountId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new UnknownAccountError(accountId);
}

/**
 * Locks one device row (SELECT ... FOR UPDATE) -- the serialization point for
 * /tx/sync's last_seq / rollback_flagged_at updates. Same reasoning as
 * lockAccount: without this, two concurrent syncs from the same device could
 * both read the same last_seq before either's advance is visible, letting a
 * replayed seq slip past the check it's supposed to fail.
 */
export async function lockDevice(trx: Transaction<Database>, deviceId: Buffer): Promise<void> {
  const row = await trx
    .selectFrom("devices")
    .select("device_id")
    .where("device_id", "=", deviceId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new Error(`unknown device: ${deviceId.toString("hex")}`);
}

/**
 * Locks two account rows, always in lexicographical account_id order, so
 * concurrent transfers touching the same pair (in either direction) serialize
 * instead of deadlocking. This is the mechanism ADV-06 (100 concurrent
 * bidirectional transfers between the same two accounts) tests.
 */
export async function lockAccountsInOrder(
  trx: Transaction<Database>,
  accountIdA: string,
  accountIdB: string,
): Promise<void> {
  const [first, second] = [accountIdA, accountIdB].sort();
  await lockAccount(trx, first);
  if (second !== first) await lockAccount(trx, second);
}

/**
 * Available balance = sum(journal) - sum(open reservations), for one account.
 * Callers inside a locked transaction get the authoritative, race-free value;
 * called without a lock (GET /accounts/:id/balance) it's a best-effort snapshot
 * that can be momentarily stale -- fine for a status display, never for the
 * authoritative check inside reserve()/transfer(), which must run this under the
 * same locked transaction as the balance check + insert, not as a separate step.
 */
export async function availableBalanceLocked(
  trx: Transaction<Database>,
  accountId: string,
  currency: string,
): Promise<bigint> {
  const journalRow = await trx
    .selectFrom("journal")
    .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
    .where("account_id", "=", accountId)
    .where("currency", "=", currency)
    .executeTakeFirst();
  const heldRow = await trx
    .selectFrom("reservations")
    .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
    .where("account_id", "=", accountId)
    .where("state", "=", "HELD")
    .executeTakeFirst();
  const journalTotal = journalRow?.total ?? 0n;
  const heldTotal = heldRow?.total ?? 0n;
  return journalTotal - heldTotal;
}
