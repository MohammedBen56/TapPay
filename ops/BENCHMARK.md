# Load test results

Ship List Phase 3. `server/bench/transfers.js`, run via `grafana/k6:2.2.0`.
Every run below hit a real running server + real Postgres (docker-compose's
`db`), not a mock.

**Hardware**: 16 vCPU, 15 GiB RAM, WSL2 (Linux 6.6, x86_64), Docker Desktop.
Not dedicated server-class hardware — treat throughput numbers as directional
for this environment, not a production capacity figure.

## 2026-08-19 — read_path (100 VUs) + write_path (3 VUs), 2 minutes

Two scenarios run together, answering two different questions (see
`transfers.js`'s own header comment for the full rationale):

**A first attempt against the normal dev server** (default `RATE_LIMIT_GLOBAL_MAX=300/min`)
produced a 94.88% failure rate — not a backend bottleneck, the load test
itself exceeding the security rate limiter by roughly 60x at peak (100 VUs
× 3 GETs/iteration ≈ 300 req/s against a 5 req/s global cap). Re-run
against a second, temporary server instance with only
`RATE_LIMIT_GLOBAL_MAX`/`RATE_LIMIT_LOGIN_MAX` relaxed (transfer-specific
rate limiting left at its real default, since `write_path` exists
specifically to test that) for real numbers:

| Metric | Value |
|---|---|
| `checks_succeeded` | 100.00% (11388/11388) |
| `http_req_failed` | 0.00% |
| read_path p50 | 5.0ms |
| read_path p90 | 622.9ms |
| read_path p95 | **712.0ms** (target: <300ms — **crossed**) |
| read_path p99 | 784.1ms (target: <800ms — held, barely) |
| Peak throughput | ~87 req/s combined across both scenarios |
| write_path | Every response was a clean 200 (settled) or 429 (rate-limited) — never a 500, timeout, or crash. Confirms the per-account transfer limit (`RATE_LIMIT_TRANSFERS_MAX`, closes D7) degrades load into typed rejections under sustained concurrency rather than leaking or failing open. |

### Where it crosses the line, and why

p50 (5ms) and p95 (712ms) are two different regimes, not one curve — that
gap is the signature of **queueing for a resource**, not uniformly slow
queries. The most likely resource: `db/kysely.ts`'s connection pool
(`DB_POOL_MAX`, default 10). 100 concurrent VUs each issuing 3 sequential
`GET`s per iteration will, at peak, want far more than 10 simultaneous
Postgres connections — requests past the 10th queue for a free connection
before Kysely/pg even sends the query, and that queue wait is exactly what
shows up as p90+ tail latency while the median (a request that got a
connection immediately) stays fast.

**This is a real nuance on an existing, deliberate design decision, not a
contradiction of it.** `config.ts`'s own comment on `dbPoolMax` explains it
was kept modest specifically because every *write* serializes on a
row-locked `accounts` row (`db/locking.ts`) — a bigger pool doesn't help
write throughput, it just moves the queue from the pool into the lock. That
reasoning is sound for the write path. It doesn't, on its own, justify
capping the *read* path's connection pool at the same low number — plain
`SELECT`s (`GET /me`, `/accounts/me/balance`, `/accounts/me/transactions`)
never touch a row lock at all, so a bigger pool genuinely would let more of
them run concurrently instead of queueing.

**Not fixed in this pass, deliberately** — `DB_POOL_MAX` is already a
config-driven tunable (CLAUDE.md §8), so raising it needs no code change,
but doing so trades connection-pool headroom against Postgres's
`max_connections` (100, shared with the sweeper, migrations, and any other
app instance) and is a real capacity decision, not a bug fix. Recorded here
as a concrete, evidence-backed recommendation for whoever makes that call,
not applied unilaterally.

### Follow-ups worth doing, not done here
- Re-run with a wider VU ramp (200, 500) to find where p99 crosses an
  unacceptable line entirely, not just the p95/300ms threshold this run's
  thresholds happened to pick.
- A future run should target the server through Caddy (`https://`), to
  measure real client-facing latency including TLS termination, once the
  relaxed-rate-limit test instance and the TLS proxy can point at each
  other cleanly.
- Correlate a run's timeline directly against the Grafana lock-wait
  heatmap (`ops/grafana/dashboards/tappay-ledger.json`) by pointing
  Prometheus's scrape target at whichever server instance is under test,
  rather than the fixed dev-server target `ops/prometheus/prometheus.yml`
  currently has.
