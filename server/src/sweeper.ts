import type { Kysely } from "kysely";
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

export interface Sweeper {
  stop: () => void;
}

export function startSweeper(db: Kysely<Database>, intervalMs: number): Sweeper {
  const timer = setInterval(() => {
    sweepExpiredReservations(db).catch((err: unknown) => {
      console.error("reservation sweeper tick failed", err);
    });
  }, intervalMs);
  timer.unref(); // don't keep the process alive just for the sweeper
  return { stop: () => clearInterval(timer) };
}
