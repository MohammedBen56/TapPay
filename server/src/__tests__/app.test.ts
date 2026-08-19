import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { config } from "../config.js";
import { db } from "../db/kysely.js";
import { redis } from "../redis.js";

describe("error handler", () => {
  it("sanitizes a 500 -- no internal error details reach the client", async () => {
    const app = buildApp({ rateLimit: false });
    // A deliberately unhandled exception, standing in for the class of bug
    // this actually caught in practice: a raw Postgres constraint violation
    // (duplicate device_id, amount <= 0) escaping to the client as verbatim
    // internal text before route-level validation existed to catch it first.
    app.get("/__test-throw", async () => {
      throw new Error("some internal detail: connection string, stack trace, whatever");
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/__test-throw" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "InternalError", message: "internal error" });
    expect(response.body).not.toContain("connection string");
  });

  it("does NOT sanitize a typed 4xx -- our own route-thrown messages still reach the client", async () => {
    // TODO(v2 M1d): repoint to POST /auth/login with a bad body once it
    // exists -- /devices/enroll is a parked P2P-proximity route (CLAUDE.md
    // §4's v2 pivot), only reachable here via the explicit test-only opt-in.
    const app = buildApp({ rateLimit: false, proximityRoutes: true });
    const response = await app.inject({ method: "POST", url: "/devices/enroll", payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("InvalidRequest");
    expect(response.json().message.length).toBeGreaterThan(0);
  });
});

describe("rate limiting", () => {
  // These tests count against real Redis-backed counters keyed by IP, and
  // fastify.inject requests all share the same synthetic IP -- without a
  // flush, a request burst run twice inside the same 1-minute window starts
  // its second run with a warm counter left over from the first, tripping
  // the limit earlier than the test expects. Found by direct reproduction:
  // running the suite twice in a row to check for flakiness failed the
  // second run. This dedicated Redis instance (docker-compose's `redis`
  // service) holds nothing but rate-limit counters, so a full flush between
  // tests is safe.
  beforeEach(async () => {
    await redis.flushdb();
  });

  it("returns a typed 429 once a route's per-route limit is exceeded", async () => {
    // A dedicated tiny limit on a throwaway route, rather than firing
    // config.rateLimitEnrollNonceMax+1 real requests against a production
    // default -- proves the mechanism, not the specific configured numbers.
    const { default: rateLimit } = await import("@fastify/rate-limit");
    const app = buildApp({ rateLimit: false });
    await app.register(rateLimit, { max: 100, timeWindow: "1 minute" }); // global default, deliberately loose
    app.get("/__test-limited", { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } }, async () => ({ ok: true }));
    await app.ready();

    const first = await app.inject({ method: "GET", url: "/__test-limited" });
    const second = await app.inject({ method: "GET", url: "/__test-limited" });
    const third = await app.inject({ method: "GET", url: "/__test-limited" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });

  it("buildApp() with no options (exactly how src/index.ts calls it) enforces the real per-route enroll-nonce limit", async () => {
    // TODO(v2 M1d): repoint to POST /auth/login's lockout/rate-limit once it
    // exists -- /devices/enroll/nonce is a parked P2P-proximity route.
    const app = buildApp({ proximityRoutes: true });
    await app.ready();

    const responses = [];
    for (let i = 0; i < config.rateLimitEnrollNonceMax + 1; i++) {
      responses.push(await app.inject({ method: "GET", url: "/devices/enroll/nonce" }));
    }

    expect(responses.slice(0, config.rateLimitEnrollNonceMax).every((r) => r.statusCode === 200)).toBe(true);
    expect(responses[config.rateLimitEnrollNonceMax]!.statusCode).toBe(429);
  });
});

describe("GET /health", () => {
  it("reports db:'ok' when Postgres is reachable -- not just process liveness", async () => {
    const app = buildApp({ rateLimit: false });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", db: "ok" });
  });
});

afterAll(async () => {
  await db.destroy();
});
