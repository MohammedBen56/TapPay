/**
 * The Prometheus registry backing GET /metrics (app.ts). Every ledger gauge
 * here is fed exclusively by checkLedgerInvariants() (ledger/invariants.ts)
 * -- the tripwire job (tripwire.ts) is the only writer -- so what a
 * dashboard shows and what the adversarial test suite asserts can never
 * silently drift apart from each other.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const register = new Registry();
collectDefaultMetrics({ register });

export const ledgerImbalanceMinor = new Gauge({
  name: "tappay_ledger_imbalance_minor",
  help: "SUM(amount) across the entire journal table, in minor units. Must be exactly 0 -- any nonzero reading is a correctness bug, not a degraded-performance signal.",
  registers: [register],
});

export const ledgerUnbalancedTxCount = new Gauge({
  name: "tappay_ledger_unbalanced_tx_count",
  help: "Count of individual tx_uuids whose journal postings don't sum to zero. A clean ledgerImbalanceMinor does not imply this is zero -- two offsetting broken transactions cancel out in the global sum.",
  registers: [register],
});

export const ledgerLastCheckTimestampSeconds = new Gauge({
  name: "tappay_ledger_last_check_timestamp_seconds",
  help: "Unix timestamp of the last completed invariant check. A tripwire that silently stopped running looks identical to one that always passes without this -- alert on staleness, not just on the other gauges going nonzero.",
  registers: [register],
});

export const transferTotal = new Counter({
  name: "tappay_transfer_total",
  help: "POST /transfers attempts by outcome. tx_uuid_conflict is a security tripwire, not a health metric -- its rate should be flat zero; any nonzero rate means someone attempted a settlement-slot hijack (CLAUDE.md §5).",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const billPaymentTotal = new Counter({
  name: "tappay_bill_payment_total",
  help: "POST /bill-payments attempts by outcome, mirroring tappay_transfer_total.",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const moneyRequestTotal = new Counter({
  name: "tappay_money_request_total",
  help: "Money-request lifecycle events by outcome (created, fulfilled, declined, and settlement failure reasons mirroring tappay_transfer_total).",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const accountLockWaitSeconds = new Histogram({
  name: "tappay_account_lock_wait_seconds",
  help: "Wall-clock time for lockAccount's SELECT ... FOR UPDATE round trip. A rising p99 here is the earliest signal of lock contention on a hot account, well before it shows up as request latency.",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});
