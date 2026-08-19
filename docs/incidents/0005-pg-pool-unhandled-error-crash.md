# 0005 — Unhandled `pg.Pool` error crashed the entire server on a database restart

**Class:** unhandled EventEmitter `'error'` event — a well-documented
node-postgres gotcha, missed when the connection pool was first built
**Found via:** Ship List Phase 3's chaos experiment (`server/scripts/
chaos-experiment.ts`) — the first time in this project's history anything
deliberately killed Postgres out from under a running server
**Status:** Fixed, with the fix verified by re-running the exact fault that
found it

## Impact

A `docker compose kill -s SIGKILL db` — modeling a real Postgres restart,
failover, or crash — did not just interrupt in-flight queries as intended.
It **crashed the entire Fastify server process**, taking down every route,
the metrics endpoint, the tripwire job, and the sweeper, for a fault that
Postgres itself recovers from automatically in seconds via WAL replay. A
routine, single-node database restart would have caused a full application
outage, not the graceful degrade-and-recover the rest of this system (pool
timeouts, Redis's `skipOnError`, the rate limiter) was already built for.

## Timeline

Surfaced on the very first chaos-experiment run: two of the run's three
fault scenarios (latency, connection reset via toxiproxy) completed cleanly,
but the third — a real `docker compose kill -s SIGKILL db` mid-burst —
produced a log line reading `"closeWithGrace triggered by an unhandled
error"` followed by the process exiting. `curl http://localhost:3000/health`
returned nothing at all afterward, confirming a full crash, not a transient
503.

## Root cause

`server/src/db/kysely.ts`'s `createDb()` constructed a `pg.Pool` with no
`'error'` event listener attached. This is `node-postgres`'s own documented
behavior, not a bug in the library: when a pooled connection that is
currently *idle* (not running a query) hits a connection-level error — which
is exactly what happens to every idle pooled connection the instant Postgres
is killed — the `Pool` emits an `'error'` event rather than rejecting a
specific query's promise (there is no in-flight query to reject). Node's
default behavior for an `EventEmitter` `'error'` event with no listener is
to throw it as an uncaught exception. `close-with-grace` (`index.ts`) then
did exactly what it's designed to do with a genuinely uncaught exception:
treat it as fatal and shut the process down — correct behavior for the
signal it was given, wrong signal to have sent it. The pool's own automatic,
correct reconnection behavior (lazily open a fresh connection on the next
query once Postgres is reachable again) never got a chance to run, because
the process was already gone.

## Fix

`createDb()` now attaches `pool.on("error", ...)`, logging the error (via
the same `setDbLogger`-injected-logger pattern already used for
`redis.ts`'s connection errors) instead of leaving it unhandled. No
reconnection logic was needed — `pg.Pool` already had that; the only
missing piece was something to catch the event instead of letting it
become an uncaught exception.

**Verified by re-running the exact fault that found it**, not just by
reading the fix: killed the real `db` container again with the fix in
place, confirmed the log now shows two `"postgres pool error (idle/
background client) -- pool will reconnect lazily on next use"` entries and
**no** `closeWithGrace` shutdown; the server process (same PID throughout)
kept serving Prometheus's `/metrics` scrapes uninterrupted across the kill
and restart, and `GET /health` correctly reported `db: "ok"` again once
Postgres came back up.

## Prevention

- `server/scripts/chaos-experiment.ts` (Ship List Phase 3) now runs this
  exact fault — and the other two — on demand and logs results to
  `ops/CHAOS_LOG.md`; this is the test that now prevents recurrence.
- The same "does every `pg.Pool` this codebase creates have an error
  listener" question is worth asking of any future direct `pg.Pool`
  construction outside `createDb()` — there should never be a second one.
