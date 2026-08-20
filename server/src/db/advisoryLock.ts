import { sql, type Kysely } from "kysely";
import type { Database } from "./kysely.js";

/**
 * Ship List v2 Phase 6 -- `sweeper.ts` and `tripwire.ts` are plain
 * per-process `setInterval` jobs. Correctness-safe with N replicas today
 * (each write is independently idempotent -- re-sweeping an already-
 * released reservation or re-running the invariant check twice is a
 * no-op), but N replicas means N copies independently firing on the same
 * schedule: real, wasted DB load that compounds with replica count, and
 * the exact kind of thing that should be fixed before horizontal scale is
 * real, not after.
 *
 * `pg_try_advisory_xact_lock` (not the non-transactional
 * `pg_try_advisory_lock` + a matching `pg_advisory_unlock`) is deliberate:
 * a session-level lock acquired on one pooled connection and released on
 * another (which `pg.Pool` gives no guarantee against across two separate
 * queries) would leak until that connection is closed. The `_xact_` variant
 * ties the lock to the transaction's lifetime -- acquired and
 * automatically released by Postgres itself on commit or rollback, no
 * matching unlock call to forget. Matches this codebase's existing
 * "boring, correct, in-Postgres" locking discipline (`db/locking.ts`)
 * rather than introducing new coordination infrastructure (e.g. Redis
 * locks) for a problem Postgres already solves natively.
 */
export async function withAdvisoryLock<T>(
  db: Kysely<Database>,
  lockKey: number,
  fn: (db: Kysely<Database>) => Promise<T>,
): Promise<T | null> {
  return db.transaction().execute(async (trx) => {
    const result = await sql<{ locked: boolean }>`select pg_try_advisory_xact_lock(${lockKey}) as locked`.execute(trx);
    if (!result.rows[0]?.locked) {
      // Another replica already holds this tick's lock -- skip, don't wait
      // (a blocking pg_advisory_xact_lock would serialize ticks across
      // replicas instead of letting exactly one run per interval, which is
      // the actual goal).
      return null;
    }
    return fn(trx);
  });
}

// Arbitrary, distinct int4-range constants -- Postgres advisory locks share
// one flat 64-bit keyspace server-wide, so these only need to not collide
// with each other or with anything else in this codebase that might one day
// take an advisory lock (nothing else does today).
export const SWEEPER_ADVISORY_LOCK_KEY = 90_210_001;
export const TRIPWIRE_ADVISORY_LOCK_KEY = 90_210_002;
export const INTEREST_ADVISORY_LOCK_KEY = 90_210_003;

/**
 * Ship List v2 Wave 2 Phase 4 -- serializes a multi-step, cross-transaction
 * critical section keyed on one account: a read-check (e.g. a rolling-window
 * SUM) that must be atomic with a LATER, separate call that writes the row
 * being summed. routes/transfers.ts's daily-velocity-cap check is the
 * motivating case: without this, concurrent POST /transfers calls on the
 * same account each read the SUM before any of them has committed a new
 * journal row, so all of them pass a per-request check that's individually
 * within the cap while their combined total sails over it -- a real,
 * concretely exploitable bypass found by /security-review, not a
 * theoretical race.
 *
 * Deliberately NOT db/locking.ts's lockAccount (a `SELECT ... FOR UPDATE`
 * row lock): that lock is exactly what MockBankAdapter.transfer() itself
 * takes, on ITS OWN separate connection/transaction, several lines after
 * this function's caller would already be calling into it. Taking the same
 * row lock here first and then calling transfer() would self-deadlock --
 * this transaction holds the row lock and awaits transfer(), while
 * transfer() blocks forever waiting for that same row lock to release,
 * which only happens once transfer() returns. An advisory lock is a wholly
 * independent locking namespace from a row lock, so holding this one across
 * the nested transfer() call cannot deadlock against transfer()'s own
 * row-lock acquisition.
 *
 * Blocking (`pg_advisory_xact_lock`, not `_try_`), unlike the singleton-job
 * helper above -- a request that arrives while another is mid-check should
 * wait its turn and then see the first one's committed result, not silently
 * skip its own check.
 *
 * `hashtext(accountId)` folds the UUID down to an int4 lock key. A hash
 * collision between two different account ids would only make this MORE
 * conservative (two unrelated accounts occasionally serialize against each
 * other unnecessarily) -- it can never make the check less correct, so this
 * is safe to treat the same way this codebase already treats UUID
 * collisions elsewhere: astronomically unlikely, and harmless even if it
 * happened.
 */
export async function withAccountAdvisoryLock<T>(
  db: Kysely<Database>,
  accountId: string,
  fn: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${accountId})::bigint)`.execute(trx);
    return fn(trx);
  });
}
