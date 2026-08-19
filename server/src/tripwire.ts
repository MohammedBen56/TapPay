import type { Kysely } from "kysely";
import type { Database } from "./db/kysely.js";
import { checkLedgerInvariants } from "./ledger/invariants.js";
import { ledgerImbalanceMinor, ledgerLastCheckTimestampSeconds, ledgerUnbalancedTxCount } from "./metrics.js";

export interface TripwireLogger {
  error: (obj: unknown, msg?: string) => void;
}

export interface Tripwire {
  /** Same shutdown contract as sweeper.ts's Sweeper.stop(): stops scheduling
   * new ticks AND awaits any tick already in flight, so index.ts's shutdown
   * sequence can call db.destroy() right after without racing a read
   * against a just-torn-down pool. */
  stop: () => Promise<void>;
}

export function startTripwire(db: Kysely<Database>, intervalMs: number, logger: TripwireLogger): Tripwire {
  let inFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    const report = await checkLedgerInvariants(db);
    // Number(), not the bigint CLAUDE.md §5 requires everywhere else: this
    // is the metrics/observability layer, which has no bigint representation
    // at all (Prometheus gauges are IEEE-754 doubles) and is never the
    // source of truth -- checkLedgerInvariants()'s own report (and the DB
    // underneath it) stays bigint. A real imbalance this large would already
    // be an emergency at any magnitude Number can't represent exactly.
    // nosemgrep: no-float-money -- metrics layer exception, see comment above
    ledgerImbalanceMinor.set(Number(report.globalImbalance));
    ledgerUnbalancedTxCount.set(report.unbalancedTransactions.length);
    ledgerLastCheckTimestampSeconds.set(report.checkedAt.getTime() / 1000);
    if (!report.ok) {
      // Not thrown: a failing invariant is a data problem to alert on
      // (the gauges above are what Prometheus/Grafana actually fire on),
      // not a process-crashing one -- the same "surfaced, never swallowed"
      // rule as everywhere else in this codebase, just via metrics + log
      // instead of an exception.
      logger.error({ report }, "ledger invariant check failed");
    }
  };

  const timer = setInterval(() => {
    inFlight = tick()
      .catch((err: unknown) => {
        logger.error(err, "ledger tripwire tick failed to run (not the same as an invariant failing -- this is the check itself erroring)");
      })
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);
  timer.unref();

  return {
    stop: async () => {
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}
