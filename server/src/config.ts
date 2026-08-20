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

function envRequired(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    throw new Error(`missing required env var ${name} -- see .env.example`);
  }
  return raw;
}

/** The exact placeholder .env.example ships for JWT_SECRET -- a server
 * that refuses to start with this literal value can never accidentally go
 * live still holding the example secret. */
const KNOWN_PLACEHOLDER_SECRETS = ["dev-only-change-me"];

/** Like envRequired, but for a value that signs/verifies tokens: also
 * rejects anything shorter than 32 bytes (weak against brute force for an
 * HMAC secret) and any known example/placeholder literal. Boot-time
 * validation, not a runtime check -- a bad secret should fail the process
 * before it ever accepts a request, not after issuing tokens signed with a
 * value no verifier can be sure came from this server. */
function envSecret(name: string): string {
  const raw = envRequired(name);
  if (raw.length < 32) {
    throw new Error(`${name} is too short (${raw.length} chars, need >=32) -- see .env.example`);
  }
  if (KNOWN_PLACEHOLDER_SECRETS.includes(raw)) {
    throw new Error(`${name} is still set to the .env.example placeholder value -- generate a real one`);
  }
  return raw;
}

export interface JwtSigningKey {
  kid: string;
  secret: string;
}

/** The active signing key, plus any still-valid-for-verification-only prior
 * keys -- the actual mechanism a JWT_SECRET rotation runbook uses (see
 * docs/adr/0003-opaque-refresh-tokens.md's neighboring rotation note): add a
 * new key here VERIFY-ONLY (in JWT_PREVIOUS_SECRETS, not as JWT_SECRET) →
 * wait out the access-token TTL so every outstanding token was signed with
 * either key → promote it to JWT_SECRET → drop the old one from
 * JWT_PREVIOUS_SECRETS. Because access tokens are short-lived (15 min
 * default) and refresh tokens are already opaque database rows rather than
 * JWTs, this only ever needs to outlast the access-token TTL, never the much
 * longer refresh-token TTL. Format: `JWT_PREVIOUS_SECRETS=kid1:secret1,kid2:secret2`. */
function parseJwtSigningKeys(currentSecret: string): JwtSigningKey[] {
  const current: JwtSigningKey = { kid: process.env.JWT_KID || "1", secret: currentSecret };
  const raw = process.env.JWT_PREVIOUS_SECRETS;
  if (!raw) return [current];

  const previous = raw.split(",").map((entry) => {
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(`invalid JWT_PREVIOUS_SECRETS entry (expected kid:secret): ${entry}`);
    }
    const kid = entry.slice(0, separatorIndex);
    const secret = entry.slice(separatorIndex + 1);
    if (secret.length < 32) {
      throw new Error(`JWT_PREVIOUS_SECRETS entry for kid ${kid} is too short (need >=32 chars)`);
    }
    return { kid, secret };
  });

  const kids = [current, ...previous].map((k) => k.kid);
  const duplicate = kids.find((kid, i) => kids.indexOf(kid) !== i);
  if (duplicate) throw new Error(`duplicate JWT signing key kid: ${duplicate}`);

  return [current, ...previous];
}

// Computed once, ahead of the config object literal, so both `jwtSecret`
// (kept for any call site that still wants the plain current-key string)
// and `jwtSigningKeys` (the kid-keyed set auth/plugin.ts's verifier walks)
// derive from exactly one envSecret() validation rather than two.
const jwtSecretValue = envSecret("JWT_SECRET");

export const config = {
  port: envInt("SERVER_PORT", 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://tappay:tappay@localhost:5433/tappay",

  /** The app's own runtime connection string -- distinct from `databaseUrl`
   * (used by node-pg-migrate and scripts/seed.ts) so migrations keep
   * running as the schema-owning role while the app itself connects as the
   * less-privileged `tappay_app` role created by migration 017. Falls back
   * to `databaseUrl` until that role/migration exists, so nothing breaks
   * mid-rollout -- see docs/THREAT_MODEL.md's role-separation row. */
  appDatabaseUrl: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://tappay:tappay@localhost:5433/tappay",

  /** Postgres connection pool bounds (db/kysely.ts's createDb). The
   * write-path reasoning that originally kept this modest still holds:
   * every balance-affecting WRITE serializes on a row-locked `accounts`
   * row (locking.ts), so a bigger pool doesn't raise write throughput --
   * writes queue on the lock either way, a bigger pool just means they
   * queue less on the POOL first, which is a pure win, not a wash.
   *
   * Raised from 10 to 30 (Ship List v2, 2026-08-20) specifically because
   * that write-path reasoning never justified capping the READ path at
   * the same number -- GET /me, /accounts/me/balance,
   * /accounts/me/transactions, /billers, /bill-payments never touch a row
   * lock at all. ops/BENCHMARK.md's 2026-08-19 load test found exactly
   * this: p50 stayed ~5ms while p95 rose to ~712ms (crossing the 300ms
   * target) under 100 concurrent read-only VUs -- the signature of
   * queueing for one of only 10 shared connections, not slow queries.
   * 30 is sized against Postgres's own default max_connections (100),
   * this being a single app instance today: 30 leaves 70 connections of
   * headroom for pgAdmin, ad-hoc psql, one-off migration/seed runs, and
   * Grafana/Prometheus (which only scrape GET /metrics over HTTP, never
   * connect to Postgres directly, so they cost nothing here). Re-run
   * ops/BENCHMARK.md's exact load test after any further change to this
   * value -- the benchmark script and thresholds already exist
   * specifically to make that re-verification cheap. A true read/write
   * pool split (a second Kysely instance for read-only routes) was
   * considered and deliberately not done in this pass -- it would touch
   * every read-only route's import, real surgery for a win this single
   * shared-pool raise already captures at this app's current scale;
   * revisit if a future benchmark run at a larger VU count shows the
   * write path itself contending with reads for pool slots, which this
   * run did not (write_path never returned a 500/timeout, only clean
   * 200s and typed 429s). */
  dbPoolMax: envInt("DB_POOL_MAX", 30),
  dbPoolConnectionTimeoutMs: envInt("DB_POOL_CONNECTION_TIMEOUT_MS", 5_000),
  dbPoolIdleTimeoutMs: envInt("DB_POOL_IDLE_TIMEOUT_MS", 30_000),

  /** How long a query waits to acquire a row lock before failing fast with
   * SQLSTATE 55P03 instead of queuing indefinitely behind a contended
   * account row -- previously unset, meaning a stuck transfer waited
   * forever and held its pool slot the whole time. */
  dbLockTimeoutMs: envInt("DB_LOCK_TIMEOUT_MS", 3_000),
  /** Ceiling on how long a query itself may run. */
  dbStatementTimeoutMs: envInt("DB_STATEMENT_TIMEOUT_MS", 10_000),
  /** Ceiling on how long a transaction may sit open without executing a
   * statement -- a safety net for a bug that leaves a transaction hanging,
   * not a budget for legitimate work: every balance-affecting transaction
   * in this codebase does its artificial-latency simulation (MockBankAdapter
   * .simulateNetwork()) BEFORE opening the transaction, not inside it, so
   * real idle time in the happy path is near zero. */
  dbIdleInTransactionSessionTimeoutMs: envInt("DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS", 5_000),

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

  /** Ledger invariant tripwire tick interval, ms (tripwire.ts) -- the
   * production job backing the imbalance/unbalanced-tx/staleness gauges
   * GET /metrics exposes. Looser than the sweeper's: this scans every
   * journal/transfers row every tick, so it trades detection latency for
   * not adding load on a hot path. */
  tripwireIntervalMs: envInt("TRIPWIRE_INTERVAL_MS", 30_000),

  /** Ship List v2 Phase 8: mock savings-account interest job (interest.ts)
   * tick interval, ms. Defaults to a real operational cadence (daily), same
   * as a real bank's overnight accrual job -- override for a live demo
   * (e.g. `INTEREST_INTERVAL_MS=10000`) rather than defaulting to something
   * demo-fast that would misrepresent real accrual timing if screenshotted. */
  interestIntervalMs: envInt("INTEREST_INTERVAL_MS", 24 * 60 * 60 * 1000),

  /** Interest credited per tick, in basis points of the savings balance
   * (1 = 0.01%). Config-driven, not hardcoded -- CLAUDE.md §8's "config
   * over constants for every tunable" rule. */
  interestRateBp: envInt("INTEREST_RATE_BP", 1),

  /** /tx/submit's `ts` sanity window (Step 8) -- a coarse bound layered behind
   * tx_uuid idempotency, the actual replay defense. Minutes, not seconds. */
  txFreshnessWindowMs: envInt("TX_FRESHNESS_WINDOW_MS", 5 * 60_000),

  /** Path to the pinned Android hardware attestation root certs (Step 7).
   * Lives under parked/ now -- see enableProximityRoutes below. */
  attestationGoogleRootsPath: process.env.ATTESTATION_GOOGLE_ROOTS_PATH ?? "src/parked/attestation/google-roots.pem",

  /** Gates the parked P2P-proximity routes (device attestation/enrollment,
   * COSE-signed /tx/submit, /tx/sync offline reconciliation) -- registered
   * only when this is true. Default false: the v2 pivot (CLAUDE.md §4) ships
   * a plain Bearer-authenticated neobank MVP first; this whole surface is
   * genuinely working, security-reviewed code being kept for when BLE/bump
   * proximity payments resume, not dead code. buildApp({ proximityRoutes:
   * true }) overrides this per test file (see server/src/parked/README.md). */
  enableProximityRoutes: process.env.ENABLE_PROXIMITY_ROUTES === "true",

  /** How long an issued enrollment nonce (attestation challenge) stays valid
   * and unconsumed before GET /devices/enroll/nonce must be called again. */
  enrollmentNonceTtlMs: envInt("ENROLLMENT_NONCE_TTL_MS", 5 * 60_000),

  /** Hard cap on the in-memory pending-nonce store (nonceStore.ts). Without
   * this, GET /devices/enroll/nonce is an unauthenticated, unbounded
   * memory-growth vector -- nonces were previously only ever removed on
   * consumption, never on expiry. */
  enrollmentNonceMaxPending: envInt("ENROLLMENT_NONCE_MAX_PENDING", 10_000),

  /** @fastify/rate-limit (Step 2, H5). Global default is generous -- it's a
   * blunt backstop, not the real control; the per-route limits below are
   * what actually target the expensive/abusable endpoints (cert-chain
   * verification, nonce issuance, batch ECDSA verification). All per-IP
   * (fastify-rate-limit's default keying), one minute windows. */
  rateLimitGlobalMax: envInt("RATE_LIMIT_GLOBAL_MAX", 300),
  rateLimitEnrollMax: envInt("RATE_LIMIT_ENROLL_MAX", 10),
  rateLimitEnrollNonceMax: envInt("RATE_LIMIT_ENROLL_NONCE_MAX", 20),
  rateLimitTxSubmitMax: envInt("RATE_LIMIT_TX_SUBMIT_MAX", 60),
  rateLimitTxSyncMax: envInt("RATE_LIMIT_TX_SYNC_MAX", 30),

  /** Server's own COSE_Sign1 identity key (Step 5), gitignored. */
  serverIdentityKeyPath: process.env.SERVER_IDENTITY_KEY_PATH ?? "keys/server_identity.pem",

  /** How long a GET /devices/:id/freshness-token stays valid for a Mode C offline
   * send (M2, spec §5: "payer holds a freshness_token issued within 24h"). Checked
   * at /tx/sync against the token's issued_at vs. the IOU's own ts. */
  offlineFreshnessTokenTtlMs: envInt("OFFLINE_FRESHNESS_TOKEN_TTL_MS", 24 * 60 * 60_000),

  /** Upper bound on a single transfer's amount, minor units. Without this (and
   * the amount > 0 check applied alongside it), a non-positive or absurd
   * amount reaches the DB's `CHECK (amount > 0)` constraint and surfaces as an
   * untyped 500 with raw Postgres text, instead of a typed 400 caught before
   * bankAdapter.transfer() ever runs. Default: 1,000,000.00 MAD. */
  maxTransferMinorUnits: BigInt(envInt("MAX_TRANSFER_MINOR_UNITS", 100_000_000)),

  /** MVP is MAD-only (CLAUDE.md §1) -- not a real multi-currency allowlist,
   * just the explicit boundary of what /tx/submit and /tx/sync will accept
   * instead of silently querying a balance in a currency that can never
   * actually hold funds. */
  supportedCurrencies: ["MAD"] as readonly string[],

  /** Hard cap on a single /tx/sync request's intents array (Step 2, H7) --
   * unbounded today, so one request can force unlimited ECDSA verifications
   * and DB transactions. */
  syncMaxIntentsPerBatch: envInt("SYNC_MAX_INTENTS_PER_BATCH", 50),

  // ---- v2 auth (CLAUDE.md §4's v2 pivot; docs/TapPay_v2_Technical_Design.md §6) ----

  /** Signs access-token JWTs. Required -- fail-fast at startup rather than
   * silently issuing tokens no verifier can be sure came from this server.
   * Also rejects a too-short secret or the literal .env.example placeholder
   * (envSecret, above) -- a bad secret fails the process before it accepts
   * a single request. */
  jwtSecret: jwtSecretValue,

  /** The kid-keyed signing-key set: index 0 is always the current signing
   * key (also exposed above as `jwtSecret` for convenience); anything after
   * it is verify-only, kept during a rotation's overlap window. See
   * parseJwtSigningKeys's own doc comment for the rotation runbook this
   * exists to support. */
  jwtSigningKeys: parseJwtSigningKeys(jwtSecretValue),

  /** Access token lifetime. Short and stateless-verifiable on purpose: the
   * hot paths (balance/history) do zero auth DB work, and a stolen token's
   * exposure window is bounded without needing server-side revocation. */
  accessTokenTtlSeconds: envInt("ACCESS_TOKEN_TTL_SECONDS", 15 * 60),

  /** Refresh token lifetime -- the long-lived credential biometric re-entry
   * keeps in the device's secure storage. Rotated on every use regardless of
   * this TTL (routes/auth.ts). */
  refreshTokenTtlSeconds: envInt("REFRESH_TOKEN_TTL_SECONDS", 60 * 24 * 60 * 60),

  /** argon2id params (OWASP baseline: m=19456 KiB, t=2, p=1). */
  argon2MemoryCostKib: envInt("ARGON2_MEMORY_COST_KIB", 19_456),
  argon2TimeCost: envInt("ARGON2_TIME_COST", 2),
  argon2Parallelism: envInt("ARGON2_PARALLELISM", 1),

  /** Login lockout: this many consecutive failures locks the customer_id for
   * loginLockoutDurationSeconds. Reset to 0 on any successful login. */
  loginMaxFailedAttempts: envInt("LOGIN_MAX_FAILED_ATTEMPTS", 5),
  loginLockoutDurationSeconds: envInt("LOGIN_LOCKOUT_DURATION_SECONDS", 15 * 60),

  /** Tight per-route limit on POST /auth/login -- the credential-stuffing
   * surface (D-series gap register, docs/TapPay_v2_Technical_Design.md §3). */
  rateLimitLoginMax: envInt("RATE_LIMIT_LOGIN_MAX", 10),

  /** GET /lookup/rib/:rib is a real information-disclosure surface by design
   * (you must be able to look up a name before sending to a typed RIB) --
   * rate-limited tightly rather than left open (§3's RIB-enumeration entry). */
  rateLimitRibLookupMax: envInt("RATE_LIMIT_RIB_LOOKUP_MAX", 20),

  /** Closes D7: POST /transfers previously had no per-route limit beyond the
   * global backstop. Keyed on the caller's own account id (request.user.aid),
   * not IP -- mobile clients sit behind carrier-grade NAT and would
   * otherwise share a limit with unrelated users on the same network.
   * Deliberately generous rather than tight: a legitimate client retrying
   * the same tx_uuid after a flaky response still counts against this
   * budget (no retry-exemption logic is implemented), so the number needs
   * headroom for a few retries, not just genuine distinct transfers. */
  rateLimitTransfersMax: envInt("RATE_LIMIT_TRANSFERS_MAX", 30),

  /** POST /bill-payments -- same reasoning/keying as rateLimitTransfersMax
   * (request.user.aid, not IP), kept as its own knob rather than reused so
   * the two surfaces can be tuned independently later. */
  rateLimitBillPaymentsMax: envInt("RATE_LIMIT_BILL_PAYMENTS_MAX", 30),

  /** Backs @fastify/rate-limit's Redis store (docker-compose.yml's `redis`
   * service) -- see its own comment for why this is safe to lose on
   * restart. */
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  // ---- Ship List v2 Wave 2 Phase 4 (fraud/risk hardening) ----
  // docs/THREAT_MODEL.md previously named both gaps below accepted-for-MVP
  // with no tracked fix -- a stolen access token could move up to
  // maxTransferMinorUnits in one call, or drain an account via many
  // below-that-cap transfers in a burst, with no additional friction.

  /** POST /auth/step-up's password-verification surface -- same
   * credential-stuffing risk profile as /auth/login (routes/auth.ts),
   * scoped to an already-authenticated caller re-proving their password. */
  rateLimitStepUpMax: envInt("RATE_LIMIT_STEP_UP_MAX", 10),

  /** Amount at/above which POST /transfers requires a fresh
   * `step_up_token` (minted by POST /auth/step-up, which re-verifies the
   * password). Proves presence for one large transfer -- the mobile
   * client cannot silently satisfy this on the user's behalf (CLAUDE.md
   * §5: the password is never cached on-device), so this is a real
   * additional factor, not client-side theater. Default: 5,000.00 MAD. */
  stepUpThresholdMinorUnits: BigInt(envInt("STEP_UP_THRESHOLD_MINOR_UNITS", 500_000)),

  /** How long a step-up token stays valid after POST /auth/step-up --
   * deliberately short: it exists to prove the password was JUST
   * re-entered, not to become a second long-lived credential.
   * auth/plugin.ts's app.authenticate rejects a step-up token outright as
   * a general bearer credential, so this TTL only bounds how long a
   * captured token could be replayed against the one route that accepts
   * it. */
  stepUpTokenTtlSeconds: envInt("STEP_UP_TOKEN_TTL_SECONDS", 5 * 60),

  /** Rolling 24h cap on total outbound debits (SUM of negative
   * journal.amount rows) per account -- independent of, and normally
   * lower than, maxTransferMinorUnits (which only bounds a SINGLE
   * transfer). Because every settlement (P2P transfer AND bill payment)
   * writes through the same journal table via bankAdapter.transfer(),
   * this bounds total damage across BOTH surfaces from one compromised
   * session, not just /transfers in isolation, with no extra wiring
   * needed in billPayments.ts. Default: 50,000.00 MAD/24h. */
  dailyVelocityCapMinorUnits: BigInt(envInt("DAILY_VELOCITY_CAP_MINOR_UNITS", 5_000_000)),
} as const;
