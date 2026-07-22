/** Every tunable named in CLAUDE.md §5/§8 lives here, read from env with a sane
 * default -- never hardcoded inline at the call site.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`invalid integer for env var ${name}: ${raw}`);
  return parsed;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) throw new Error(`invalid float for env var ${name}: ${raw}`);
  return parsed;
}

export const config = {
  port: envInt("SERVER_PORT", 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://tappay:tappay@localhost:5433/tappay",

  /** MockBankAdapter artificial latency range, spec §2.1. */
  mockLatencyMinMs: envInt("MOCK_LATENCY_MIN_MS", 200),
  mockLatencyMaxMs: envInt("MOCK_LATENCY_MAX_MS", 800),

  /** Fraction of MockBankAdapter calls that fail on purpose, for adversarial tests.
   * 0 in normal dev/prod; tests override per-call via MockBankAdapter's constructor. */
  faultInjectionRate: envFloat("FAULT_INJECTION_RATE", 0),

  /** Default hold TTL when a caller doesn't specify one, seconds. */
  defaultReservationTtlSeconds: envInt("RESERVATION_TTL_SECONDS", 30),

  /** Reservation-expiry sweeper tick interval, ms (Step 4). */
  sweeperIntervalMs: envInt("SWEEPER_INTERVAL_MS", 5_000),

  /** /tx/submit's `ts` sanity window (Step 8) -- a coarse bound layered behind
   * tx_uuid idempotency, the actual replay defense. Minutes, not seconds. */
  txFreshnessWindowMs: envInt("TX_FRESHNESS_WINDOW_MS", 5 * 60_000),

  /** Path to the pinned Android hardware attestation root certs (Step 7). */
  attestationGoogleRootsPath: process.env.ATTESTATION_GOOGLE_ROOTS_PATH ?? "src/attestation/google-roots.pem",

  /** Server's own COSE_Sign1 identity key (Step 5), gitignored. */
  serverIdentityKeyPath: process.env.SERVER_IDENTITY_KEY_PATH ?? "keys/server_identity.pem",
} as const;
