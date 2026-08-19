# Chaos experiment log

Dated rows, oldest first. Each run injects a real infrastructure fault (via toxiproxy or a real `docker compose kill`) during a burst of concurrent transfers, then runs checkLedgerInvariants() -- see server/scripts/chaos-experiment.ts.

| Date (UTC) | Fault | Attempted | Succeeded | Failed | Invariants | Notes |
|---|---|---|---|---|---|---|
| 2026-08-19T18:34:17.246Z | latency (250ms +/- 75ms) | 20 | 9 | 11 | ✅ clean | Connections delayed, none dropped -- but lock contention on the small account pool compounds with latency, so some queued transfers time out waiting for a lock rather than completing slowly. No corruption either way. |
| 2026-08-19T18:34:17.246Z | connection reset (~50% of connections) | 20 | 17 | 3 | ✅ clean | Roughly half the calls should fail with a raw connection error -- the invariant that matters is that a failed call never partially writes, not that every call succeeds. |
| 2026-08-19T18:34:17.246Z | sigkill (docker compose kill -s SIGKILL db) | 20 | 20 | 0 | ✅ clean | Real process kill, not a simulated fault. In-flight transactions at kill time are expected to fail or never have started; Postgres's own WAL replay on restart is what's actually being proven here. |
