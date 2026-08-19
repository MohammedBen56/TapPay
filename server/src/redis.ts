/**
 * The Redis client backing @fastify/rate-limit's distributed store
 * (app.ts). Configured to fail OPEN, deliberately: rate limiting is a
 * defense-in-depth control, not a correctness guarantee the ledger depends
 * on, so a Redis outage should degrade to "requests aren't rate-limited for
 * a while," never "the app can't serve traffic." `enableOfflineQueue:
 * false` means a call made while disconnected rejects immediately instead
 * of queuing (which would otherwise let a Redis outage silently pile up
 * unbounded pending commands); `@fastify/rate-limit`'s own `skipOnError:
 * true` (set at registration, app.ts) is what turns that rejection into
 * "allow the request" rather than a 500.
 */
import Redis from "ioredis";
import { config } from "./config.js";

// NOT lazyConnect: with enableOfflineQueue false, a command issued before
// the connection finishes its handshake rejects immediately -- which
// skipOnError then treats as "allow the request." Combined with lazy
// connection, that's not a narrow startup race: it's every request in the
// first burst after boot (or after any reconnect) sailing through
// unratelimited until the handshake completes, found by direct
// reproduction (a burst-of-requests test that should trip a limit at
// request N stopped tripping at all once this was lazy). Connecting eagerly
// means the handshake happens once, at boot, well before real traffic (or a
// test's burst) arrives.
export const redis = new Redis(config.redisUrl, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 1_000,
});

redis.on("error", (err: Error) => {
  // Never let an unhandled 'error' event crash the process -- ioredis
  // requires a listener or a connection failure becomes an uncaught
  // exception. Logged, not swallowed silently: this codebase's own rule
  // (CLAUDE.md §8) is that errors are surfaced, never swallowed.
  redisLogger?.error(err, "redis connection error");
});

// Set by app.ts once Fastify's own logger exists, so redis.ts doesn't need
// its own console.error escape hatch (sweeper.ts's old one, fixed earlier
// in this same pass) -- undefined only in the brief window before app.ts
// runs, during which a connection error is vanishingly unlikely.
let redisLogger: { error: (obj: unknown, msg?: string) => void } | undefined;
export function setRedisLogger(logger: { error: (obj: unknown, msg?: string) => void }): void {
  redisLogger = logger;
}
