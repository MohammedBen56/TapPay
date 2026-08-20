import type { Kysely } from "kysely";
import { SWEEPER_ADVISORY_LOCK_KEY, withAdvisoryLock } from "./db/advisoryLock.js";
import type { Database } from "./db/kysely.js";

/** Releases stale HELD reservations. Idempotent (re-running with nothing expired
 * is a no-op) and safe to run concurrently with commit() -- see MockBankAdapter's
 * guarded UPDATE, which is the other half of why this race is benign. */
export async function sweepExpiredReservations(db: Kysely<Database>): Promise<number> {
  const result = await db
    .updateTable("reservations")
    .set({ state: "RELEASED" })
    .where("state", "=", "HELD")
    .where("expires_at", "<", new Date())
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export interface SweeperLogger {
  error: (obj: unknown, msg?: string) => void;
}

export interface Sweeper {
  /** Stops scheduling new ticks AND awaits any tick already in flight, so a
   * caller doing `await sweeper.stop()` before `db.destroy()` (index.ts's
   * shutdown sequence) can't have the pool torn down mid-UPDATE under it --
   * this is a second concurrent writer against the same database, exactly
   * like every route, and needs the same drain-before-destroy treatment. */
  stop: () => Promise<void>;
}

export function startSweeper(db: Kysely<Database>, intervalMs: number, logger: SweeperLogger): Sweeper {
  let inFlight: Promise<number | null> | null = null;

  const timer = setInterval(() => {
    // Ship List v2 Phase 6: only the replica that wins the advisory lock
    // actually sweeps this tick -- see db/advisoryLock.ts's own doc comment.
    inFlight = withAdvisoryLock(db, SWEEPER_ADVISORY_LOCK_KEY, sweepExpiredReservations)
      .catch((err: unknown) => {
        logger.error(err, "reservation sweeper tick failed");
        return 0;
      })
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);
  timer.unref(); // don't keep the process alive just for the sweeper

  return {
    stop: async () => {
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}
