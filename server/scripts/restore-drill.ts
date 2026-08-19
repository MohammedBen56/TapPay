/**
 * Ship List Phase 3: proves the restore half of "we have backups" actually
 * works, not just that `pg_dump` doesn't error. Dumps the real dev database
 * (via the docker-compose `db` service, which already has pg_dump --
 * nothing extra to install), restores it into a throwaway, disposable
 * postgres:16 container, and runs the SAME checkLedgerInvariants() the
 * production tripwire/property test/CI use -- so "the restore succeeded"
 * means the ledger is actually intact, not just that psql exited 0.
 *
 * Scope, stated plainly: this drill only proves a dump CAN be restored
 * cleanly and quickly. It does not prove backups are being taken on any
 * schedule -- this project has no automated backup job yet. That's a real,
 * separate gap; this script is the restore-verification half, not the
 * whole disaster-recovery story.
 *
 * Usage: pnpm --filter server restore-drill
 */
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createDb } from "../src/db/kysely.js";
import { checkLedgerInvariants } from "../src/ledger/invariants.js";

const CONTAINER_NAME = `tappay-restore-drill-${randomUUID().slice(0, 8)}`;
const REPORT_PATH = "../ops/RESTORE_DRILL.md";

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function cleanup(): void {
  spawnSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
}

async function main(): Promise<void> {
  const wallClockStart = Date.now();

  console.log(`[1/5] Starting throwaway postgres:16 container (${CONTAINER_NAME})...`);
  run(
    `docker run -d --name ${CONTAINER_NAME} -e POSTGRES_DB=tappay -e POSTGRES_USER=tappay -e POSTGRES_PASSWORD=tappay -P postgres:16`,
  );

  const portMapping = run(`docker port ${CONTAINER_NAME} 5432/tcp`);
  // Docker prints one line per bound address (IPv4 + IPv6); take the first,
  // format `0.0.0.0:PORT`.
  const hostPort = portMapping.split("\n")[0]?.split(":").pop();
  if (!hostPort) throw new Error(`could not determine host port from: ${portMapping}`);

  console.log(`[2/5] Waiting for the throwaway container to accept connections (port ${hostPort})...`);
  const readyDeadline = Date.now() + 30_000;
  for (;;) {
    const result = spawnSync("docker", ["exec", CONTAINER_NAME, "pg_isready", "-U", "tappay"]);
    if (result.status === 0) break;
    if (Date.now() > readyDeadline) throw new Error("throwaway container never became ready within 30s");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("[3/5] Dumping the real dev database and restoring into the throwaway container...");
  const restoreStart = Date.now();
  // --no-owner --no-privileges: pg_dump never includes CREATE ROLE (roles
  // are cluster-level, not database-level, so a per-database dump can't
  // self-describe them) -- found by direct reproduction, a first attempt
  // without these flags failed restoring with "role tappay_app does not
  // exist" on migration 017's GRANT statements. Stripping ownership/
  // privilege statements is the correct scope here, not a workaround: this
  // drill proves DATA recoverability and ledger integrity; role separation
  // is already proven by its own dedicated test
  // (db/__tests__/appRolePrivileges.test.ts), not re-tested here.
  //
  // A single shell pipeline (dump -> restore) so the dump is never fully
  // buffered in this process's memory -- fine at this project's current
  // data volume either way, but the right habit for a script that's
  // supposed to model a real restore.
  execSync(
    `docker compose exec -T db pg_dump --no-owner --no-privileges -U tappay tappay | docker exec -i ${CONTAINER_NAME} psql -U tappay -d tappay -q -v ON_ERROR_STOP=1`,
    { cwd: "..", stdio: ["ignore", "ignore", "inherit"] },
  );
  const restoreMs = Date.now() - restoreStart;

  console.log("[4/5] Running checkLedgerInvariants() against the restored copy...");
  const restoredDb = createDb(`postgres://tappay:tappay@localhost:${hostPort}/tappay`);
  const report = await checkLedgerInvariants(restoredDb);
  await restoredDb.destroy();

  const totalMs = Date.now() - wallClockStart;

  console.log("[5/5] Done.");
  console.log(
    JSON.stringify(
      report,
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );
  console.log(`restore: ${restoreMs}ms, total (incl. container startup): ${totalMs}ms`);

  const row = `| ${new Date().toISOString()} | ${restoreMs}ms | ${totalMs}ms | ${report.ok ? "✅ clean" : "❌ FAILED"} |\n`;
  if (!existsSync(REPORT_PATH)) {
    writeFileSync(
      REPORT_PATH,
      "# Restore drill log\n\nDated rows, oldest first. Each run dumps the real dev database, restores it into a throwaway container, and runs checkLedgerInvariants() against the restored copy -- see server/scripts/restore-drill.ts.\n\n| Date (UTC) | Restore time | Total time | Result |\n|---|---|---|---|\n",
    );
  }
  appendFileSync(REPORT_PATH, row);

  if (!report.ok) {
    console.error("RESTORE DRILL FAILED: the restored database's ledger invariants are violated.");
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error("restore drill errored:", err);
    process.exitCode = 1;
  })
  .finally(cleanup);
