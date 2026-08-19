/**
 * Hand-runnable wrapper around checkLedgerInvariants() -- `pnpm --filter
 * server check-invariants` against whatever DATABASE_URL points at (the dev
 * database by default). Prints the full report as JSON and exits 1 if any
 * invariant is violated, so it's also usable as a CI/cron step, not just a
 * manual sanity check.
 */
import { db } from "../src/db/kysely.js";
import { checkLedgerInvariants } from "../src/ledger/invariants.js";

const report = await checkLedgerInvariants(db);

console.log(
  JSON.stringify(
    report,
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ),
);

await db.destroy();

if (!report.ok) {
  console.error("ledger invariants violated -- see report above");
  process.exit(1);
}
