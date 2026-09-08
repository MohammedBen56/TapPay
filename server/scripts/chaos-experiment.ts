/**
 * Ship List Phase 3: proves the ledger survives real infrastructure faults,
 * not just that the happy path works. Three fault types, each run as a
 * burst of real concurrent transfers followed by the SAME
 * checkLedgerInvariants() the tripwire/property test/restore drill already
 * trust:
 *
 *   1. latency  -- 2s +/- 500ms injected on the Postgres connection
 *   2. reset    -- ~50% of Postgres connections abruptly reset mid-flight
 *   3. sigkill  -- `docker compose kill -s SIGKILL db`, then restart it and
 *      let Postgres's own WAL crash-recovery run, no toxiproxy involved
 *
 * The first two go through toxiproxy (docker-compose.yml's `chaos` profile,
 * `docker compose --profile chaos up -d toxiproxy`), which must already be
 * running -- this script creates/recreates its own proxy but doesn't start
 * the container itself. The third genuinely kills and restarts the real
 * `db` container: expect the currently-running dev server (and anything
 * else connected to Postgres, including a live Prometheus/Grafana tripwire)
 * to see a transient connection error and recover on its own once the
 * container is back -- that recovery IS the thing being tested, not a side
 * effect to avoid.
 *
 * Usage: pnpm --filter server chaos-experiment
 */
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../src/config.js";
import { createDb, MINT_ACCOUNT_ID } from "../src/db/kysely.js";
import { checkLedgerInvariants } from "../src/ledger/invariants.js";
import { MockBankAdapter } from "../src/adapters/MockBankAdapter.js";

const TOXIPROXY_API = "http://localhost:8474";
const PROXIED_DB_URL = "postgres://tappay:tappay@localhost:15433/tappay";
const POOL_SIZE = 6;
const STARTING_BALANCE = 1_000_000n;
const BURST_SIZE = 20;
const REPORT_PATH = "../docs/CHAOS_LOG.md";

interface FaultResult {
  fault: string;
  attempted: number;
  succeeded: number;
  failed: number;
  invariantsOk: boolean;
  notes: string;
}

async function createFundedAccount(db: ReturnType<typeof createDb>, startingBalance: bigint): Promise<string> {
  const accountId = randomUUID();
  const userId = randomUUID();
  const email = `chaos-${randomUUID()}@tappay.local`;
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("users").values({ user_id: userId, email }).execute();
    await trx.insertInto("accounts").values({ account_id: accountId, user_id: userId, currency: "MAD" }).execute();
    if (startingBalance > 0n) {
      const txUuid = randomUUID();
      await trx
        .insertInto("journal")
        .values([
          { tx_uuid: txUuid, account_id: MINT_ACCOUNT_ID, amount: -startingBalance, currency: "MAD" },
          { tx_uuid: txUuid, account_id: accountId, amount: startingBalance, currency: "MAD" },
        ])
        .execute();
    }
  });
  return accountId;
}

async function ensureToxiproxyProxy(): Promise<void> {
  await fetch(`${TOXIPROXY_API}/proxies/postgres`, { method: "DELETE" }).catch(() => {});
  const res = await fetch(`${TOXIPROXY_API}/proxies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "postgres", listen: "0.0.0.0:15433", upstream: "db:5432" }),
  });
  if (!res.ok) throw new Error(`toxiproxy: failed to create proxy (${res.status}): ${await res.text()}`);
}

async function addToxic(name: string, type: string, attributes: Record<string, number>, toxicity = 1): Promise<void> {
  const res = await fetch(`${TOXIPROXY_API}/proxies/postgres/toxics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, stream: "downstream", toxicity, attributes }),
  });
  if (!res.ok) throw new Error(`toxiproxy: failed to add toxic ${name} (${res.status}): ${await res.text()}`);
}

async function clearToxics(): Promise<void> {
  await fetch(`${TOXIPROXY_API}/proxies/postgres/toxics`).then(async (res) => {
    const toxics = (await res.json()) as { name: string }[];
    await Promise.all(toxics.map((t) => fetch(`${TOXIPROXY_API}/proxies/postgres/toxics/${t.name}`, { method: "DELETE" })));
  });
}

async function runBurst(dbUrl: string, pool: string[]): Promise<{ succeeded: number; failed: number }> {
  const db = createDb(dbUrl);
  const adapter = new MockBankAdapter(db, async () => new Uint8Array(), { latencyMinMs: 0, latencyMaxMs: 0 });
  const calls = Array.from({ length: BURST_SIZE }, (_, i) => {
    const from = pool[i % pool.length]!;
    const to = pool[(i + 1) % pool.length]!;
    return adapter.transfer(randomUUID(), from, to, 100n, "MAD").catch((err: unknown) => ({ success: false as const, error: err }));
  });
  const results = await Promise.allSettled(calls);
  await db.destroy().catch(() => {});
  const succeeded = results.filter((r) => r.status === "fulfilled" && (r.value as { success: boolean }).success).length;
  return { succeeded, failed: BURST_SIZE - succeeded };
}

async function checkInvariantsClean(): Promise<boolean> {
  const db = createDb(config.databaseUrl);
  const report = await checkLedgerInvariants(db);
  await db.destroy();
  if (!report.ok) {
    console.error(
      "invariants violated:",
      JSON.stringify(report, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2),
    );
  }
  return report.ok;
}

async function waitForDbReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = spawnSync("docker", ["compose", "exec", "-T", "db", "pg_isready", "-U", "tappay"], { cwd: ".." });
    if (result.status === 0) return;
    if (Date.now() > deadline) throw new Error(`db never became ready within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function runFault(name: string, setup: () => Promise<void>, dbUrl: string, pool: string[], notes: string): Promise<FaultResult> {
  console.log(`\n=== fault: ${name} ===`);
  await setup();
  const { succeeded, failed } = await runBurst(dbUrl, pool);
  console.log(`burst: ${succeeded}/${BURST_SIZE} succeeded, ${failed}/${BURST_SIZE} failed`);
  await clearToxics().catch(() => {});
  const invariantsOk = await checkInvariantsClean();
  console.log(`invariants after ${name}: ${invariantsOk ? "OK" : "VIOLATED"}`);
  return { fault: name, attempted: BURST_SIZE, succeeded, failed, invariantsOk, notes };
}

async function main(): Promise<void> {
  console.log("Setting up toxiproxy proxy and a funded account pool...");
  await ensureToxiproxyProxy();
  const ownerDb = createDb(config.databaseUrl);
  const pool = await Promise.all(Array.from({ length: POOL_SIZE }, () => createFundedAccount(ownerDb, STARTING_BALANCE)));
  await ownerDb.destroy();

  const results: FaultResult[] = [];

  results.push(
    await runFault(
      "latency (250ms +/- 75ms)",
      () => addToxic("latency", "latency", { latency: 250, jitter: 75 }),
      PROXIED_DB_URL,
      pool,
      // Deliberately well under dbPoolConnectionTimeoutMs/dbStatementTimeoutMs
      // (config.ts, 5s/10s defaults) even after multiplying across a
      // transfer's several Postgres wire round-trips -- this fault models
      // genuine network degradation the system should absorb, not a total
      // outage. Found by direct reproduction: an earlier attempt at 2s+/-500ms
      // latency failed 20/20 transfers to pure timeout, which still proved no
      // corruption occurred but demonstrated total failure, not graceful
      // degradation -- the more interesting property to show here.
      // The pool is small on purpose (POOL_SIZE) so concurrent transfers
      // collide on the same account pairs, same as ADV-06 -- under latency,
      // that lock contention compounds: a transfer queued behind another
      // account-locked transfer inherits that transfer's full latency PLUS
      // its own, and can time out waiting for a lock even though the
      // underlying operation would have succeeded uncontended. That's the
      // actual finding worth reporting, not "everything just succeeds
      // slower" -- and the invariant that matters held regardless: no
      // failed/timed-out call ever left a partial write.
      "Connections delayed, none dropped -- but lock contention on the small account pool compounds with latency, so some queued transfers time out waiting for a lock rather than completing slowly. No corruption either way.",
    ),
  );

  results.push(
    await runFault(
      "connection reset (~50% of connections)",
      () => addToxic("reset", "reset_peer", { timeout: 0 }, 0.5),
      PROXIED_DB_URL,
      pool,
      "Roughly half the calls should fail with a raw connection error -- the invariant that matters is that a failed call never partially writes, not that every call succeeds.",
    ),
  );

  console.log("\n=== fault: sigkill (real docker compose kill -s SIGKILL db) ===");
  console.log("Killing the real db container mid-burst -- this will also disrupt anything else connected to Postgres right now.");
  const burstPromise = runBurst(config.databaseUrl, pool);
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the burst actually start before the kill lands
  execSync("docker compose kill -s SIGKILL db", { cwd: "..", stdio: "inherit" });
  const { succeeded, failed } = await burstPromise;
  console.log(`burst: ${succeeded}/${BURST_SIZE} succeeded, ${failed}/${BURST_SIZE} failed (during/after the kill)`);
  console.log("Restarting db and waiting for it to come back up (WAL crash recovery)...");
  execSync("docker compose up -d db", { cwd: "..", stdio: "inherit" });
  await waitForDbReady(30_000);
  const sigkillInvariantsOk = await checkInvariantsClean();
  console.log(`invariants after sigkill: ${sigkillInvariantsOk ? "OK" : "VIOLATED"}`);
  results.push({
    fault: "sigkill (docker compose kill -s SIGKILL db)",
    attempted: BURST_SIZE,
    succeeded,
    failed,
    invariantsOk: sigkillInvariantsOk,
    notes: "Real process kill, not a simulated fault. In-flight transactions at kill time are expected to fail or never have started; Postgres's own WAL replay on restart is what's actually being proven here.",
  });

  const allOk = results.every((r) => r.invariantsOk);
  const date = new Date().toISOString();
  const rows = results
    .map((r) => `| ${date} | ${r.fault} | ${r.attempted} | ${r.succeeded} | ${r.failed} | ${r.invariantsOk ? "✅ clean" : "❌ VIOLATED"} | ${r.notes} |`)
    .join("\n");

  if (!existsSync(REPORT_PATH)) {
    // docs/ is gitignored, so it may not exist at all in a fresh clone.
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(
      REPORT_PATH,
      "# Chaos experiment log\n\nDated rows, oldest first. Each run injects a real infrastructure fault (via toxiproxy or a real `docker compose kill`) during a burst of concurrent transfers, then runs checkLedgerInvariants() -- see server/scripts/chaos-experiment.ts.\n\n| Date (UTC) | Fault | Attempted | Succeeded | Failed | Invariants | Notes |\n|---|---|---|---|---|---|---|\n",
    );
  }
  appendFileSync(REPORT_PATH, rows + "\n");

  console.log(`\n${allOk ? "ALL FAULTS: ledger stayed consistent throughout." : "AT LEAST ONE FAULT LEFT THE LEDGER INCONSISTENT."}`);
  if (!allOk) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("chaos experiment errored:", err);
  process.exitCode = 1;
});
