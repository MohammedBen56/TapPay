/**
 * Backing logic for the split /health/live, /health/ready, /health/startup
 * endpoints (app.ts). Kept out of app.ts so the migration-freshness check is
 * independently testable and so the file reading it does isn't buried inside
 * a much larger route-registration function.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import type { Database } from "./db/kysely.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** The latest migration file on disk, by filename sort order -- node-pg-migrate's
 * own numeric prefix convention (001_, 002_, ...) makes lexicographic sort
 * correct here without needing to parse timestamps. */
export function latestMigrationName(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".cjs"))
    .sort();
  const last = files[files.length - 1];
  if (!last) throw new Error(`no migration files found in ${MIGRATIONS_DIR}`);
  return last.replace(/\.cjs$/, "");
}

/** True once the database's most-recently-applied migration matches the
 * newest migration file this deployed code ships with. False during the
 * window where new code has started but migrations haven't run yet (or ran
 * against an older schema) -- the exact case /health/startup exists to turn
 * into "not started yet" instead of a runtime 500 storm on every route that
 * touches a column the old schema doesn't have. */
export async function appliedMigrationIsCurrent(db: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ name: string }>`select name from pgmigrations order by id desc limit 1`.execute(db);
  return result.rows[0]?.name === latestMigrationName();
}

/** Races a query against a timeout so a stalled connection makes /health/ready
 * report "not ready" quickly rather than hang behind whatever the caller's
 * own timeout is (or isn't). Independent of the pool-level statement_timeout
 * configured in db/kysely.ts -- this is a second, local safety net specific
 * to the health check itself. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
