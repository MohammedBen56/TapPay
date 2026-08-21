import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import { sql } from "kysely";
import { setAuditLogger } from "./audit/log.js";
import { registerAuthPlugin } from "./auth/plugin.js";
import { config } from "./config.js";
import { db, setDbLogger } from "./db/kysely.js";
import { appliedMigrationIsCurrent, withTimeout } from "./health.js";
import { loggerOptions } from "./logging.js";
import { register } from "./metrics.js";
import { buildOpenApiDocument } from "./openapi.js";
import { redis, setRedisLogger } from "./redis.js";
import { registerDeviceRoutes } from "./parked/routes/devices.js";
import { registerSyncRoutes } from "./parked/routes/sync.js";
import { registerTxCoseRoutes } from "./parked/routes/tx-cose.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBeneficiaryRoutes } from "./routes/beneficiaries.js";
import { registerBillPaymentRoutes } from "./routes/billPayments.js";
import { registerDisputeRoutes } from "./routes/disputes.js";
import { registerGoalRoutes } from "./routes/goals.js";
import { registerLookupRoutes } from "./routes/lookup.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerMoneyRequestRoutes } from "./routes/moneyRequests.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerPushTokenRoutes } from "./routes/pushTokens.js";
import { registerSubscriptionRoutes } from "./routes/subscriptions.js";
import { registerSupportRoutes } from "./routes/support.js";
import { registerTransferRoutes } from "./routes/transfers.js";
import { registerTxRoutes } from "./routes/tx.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Flipped true by index.ts's SIGTERM handler, before app.close() starts
     * draining in-flight requests. /health/ready reads this so the load
     * balancer stops sending new traffic during the drain window, without
     * the process reporting itself dead (that's /health/live's job, and it
     * must keep reporting alive through a graceful drain -- only a genuinely
     * stuck process should get killed and restarted). */
    isShuttingDown: boolean;
  }
}

export interface BuildAppOptions {
  /** Set false to skip registering @fastify/rate-limit entirely -- every
   * existing test file fires many requests in quick succession against one
   * shared app instance, which the real per-route limits are deliberately
   * tight enough to trip. Route-level `config.rateLimit` overrides on
   * individual routes are simply inert (not an error) when the plugin was
   * never registered, so no other code needs to know this happened. */
  rateLimit?: boolean;

  /** Registers the parked P2P-proximity routes (device attestation/
   * enrollment, COSE-signed /tx/submit, /tx/sync offline reconciliation)
   * alongside the live v2 MVP routes. Defaults to config.enableProximityRoutes
   * (env ENABLE_PROXIMITY_ROUTES, false unless set) -- see
   * server/src/parked/README.md. Tests for the parked code opt back in via
   * `{ proximityRoutes: true }` explicitly rather than relying on the env
   * default. */
  proximityRoutes?: boolean;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: loggerOptions });
  app.decorate("isShuttingDown", false);
  app.register(sensible);
  // Ship List v2 Wave 2 Phase 3: static mode -- a hand-assembled document
  // (openapi.ts), NOT automatic per-route schema introspection. See
  // openapi.ts's own header comment for why: every route here does its
  // own manual Zod validation with a project-specific error shape, and
  // wiring Fastify's own schema-driven AJV validator on top would risk
  // changing real request-handling behavior for the sake of documentation.
  void app.register(swagger, { mode: "static", specification: { document: buildOpenApiDocument() } });
  registerAuthPlugin(app);
  setRedisLogger(app.log);
  setDbLogger(app.log);
  setAuditLogger(app.log);

  if (options.rateLimit !== false) {
    // Registered before the routes below, on the same (non-encapsulated) app
    // instance, so its onRequest hook covers every route -- including their
    // own tighter config.rateLimit overrides (devices.ts/tx.ts/sync.ts).
    //
    // MUST be sequenced via .after(), not just declared earlier in this
    // function: app.register() defers the plugin's own body (including its
    // internal `addHook('onRoute', ...)` call that reads each route's
    // `config.rateLimit`) to Fastify's boot phase, while the plain
    // `app.get()`/`app.post()` calls below take effect immediately. Without
    // .after(), every route below gets declared -- and has its onRoute hooks
    // snapshotted -- before the rate-limit plugin's own hook is attached,
    // silently disabling rate limiting on every route, with no error.
    // Confirmed by direct reproduction, not assumption.
    //
    // Backed by Redis (redis.ts), not the plugin's default in-memory store:
    // an in-process counter becomes N times too permissive the instant
    // there's more than one server instance, since each instance counts
    // independently against the same limit. skipOnError: true means a
    // Redis outage fails OPEN (requests proceed unlimited) rather than
    // failing every request closed -- rate limiting is defense-in-depth,
    // not something the ledger's correctness depends on, so degrading to
    // "unlimited for a while" is the right failure mode, not "the app is
    // down."
    app
      .register(rateLimit, { max: config.rateLimitGlobalMax, timeWindow: "1 minute", redis, skipOnError: true })
      .after(() => {
        registerRoutes();
      });
  } else {
    registerRoutes();
  }

  function registerRoutes(): void {
    // Liveness: process is up, full stop. Deliberately never touches
    // Postgres -- a DB-checking liveness probe means a brief Postgres blip
    // gets every pod killed and restarted simultaneously by the orchestrator,
    // turning a few seconds of DB unavailability into a full outage. This is
    // the most common health-check mistake in production systems, and it's
    // exactly the one this split exists to avoid.
    app.get("/health/live", async () => ({ status: "ok" }));

    // Readiness: DB reachable AND not mid-shutdown-drain. A load balancer
    // pulls a pod from rotation on 503 here without killing it -- unlike
    // liveness, failing this is meant to be routine and non-fatal.
    app.get("/health/ready", async (_request, reply) => {
      if (app.isShuttingDown) {
        return reply.status(503).send({ status: "error", reason: "shutting_down" });
      }
      try {
        await withTimeout(sql`select 1`.execute(db), 1_500);
        return { status: "ok", db: "ok" };
      } catch {
        return reply.status(503).send({ status: "error", db: "unreachable" });
      }
    });

    // Startup: only reports ready once the database's most-recently-applied
    // migration matches the newest migration file this deployed code ships
    // with. Makes "new code deployed ahead of its schema" a failed startup
    // probe instead of a runtime 500 storm on the first request that touches
    // a column the old schema doesn't have yet.
    app.get("/health/startup", async (_request, reply) => {
      try {
        const current = await withTimeout(appliedMigrationIsCurrent(db), 1_500);
        if (!current) {
          return reply.status(503).send({ status: "error", reason: "migrations_pending" });
        }
        return { status: "ok" };
      } catch {
        return reply.status(503).send({ status: "error", db: "unreachable" });
      }
    });

    // Kept as a DB-aware alias of /health/ready -- the parked mobile
    // connectivity probe (CLAUDE.md §4 Phase 5) uses this exact path as its
    // online/offline signal, so "the process is up but can't reach Postgres"
    // must keep reporting unhealthy here, not 200.
    app.get("/health", async (_request, reply) => {
      try {
        await withTimeout(sql`select 1`.execute(db), 1_500);
        return { status: "ok", db: "ok" };
      } catch {
        return reply.status(503).send({ status: "error", db: "unreachable" });
      }
    });

    // Unauthenticated, matching standard practice for a scrape endpoint --
    // real deployments isolate it at the network layer (Prometheus reaches
    // it over a private network the public internet never touches) rather
    // than app-layer auth, since a scraper credential would just become
    // another secret Prometheus's own config has to hold. Fine for this
    // local/demo docker-compose stack, where nothing routes to it from
    // outside the host.
    app.get("/metrics", async (_request, reply) => {
      reply.header("Content-Type", register.contentType);
      return register.metrics();
    });

    // Ship List v2 Wave 2 Phase 3: the live v2 API surface moves under
    // /v1 -- cheap now (one owner, one client), expensive later once a
    // real client pins to unversioned routes. Scoped deliberately: only
    // the actual v2 API (auth/accounts/me/transfers/lookup/
    // beneficiaries/bill-payments). /health*, /metrics stay unprefixed
    // (infra/ops endpoints, not versioned API surface -- a decision made
    // explicitly, not defaulted). The parked P2P surface (tx.ts, and the
    // device/COSE/sync routes below when enabled) is its OWN trust
    // boundary and wire contract (COSE-signed, not JWT -- see
    // docs/THREAT_MODEL.md) with its own already-passing test suite
    // asserting bare paths -- deliberately NOT moved under /v1 in this
    // pass, to avoid conflating two different API surfaces' versioning.
    //
    // Registered as a nested, prefixed child of `app` (not a sibling
    // top-level register) specifically so it inherits the rate-limit
    // plugin's onRoute hook already attached to `app` above -- Fastify's
    // onRoute hooks apply across encapsulation boundaries to any route
    // registered after the hook was added, regardless of prefix nesting.
    // Verified live after this change (curl through /v1/... and confirm
    // both the route resolves AND per-route rate limiting still fires).
    void app.register(
      async (v1) => {
        // Unauthenticated, matching /metrics' reasoning above -- a real
        // bank integration partner needs to fetch this before they have
        // any credential to authenticate with.
        v1.get("/openapi.json", async () => app.swagger());

        registerAuthRoutes(v1);
        registerAccountRoutes(v1);
        registerMeRoutes(v1);
        registerTransferRoutes(v1);
        registerLookupRoutes(v1);
        registerBeneficiaryRoutes(v1);
        registerBillPaymentRoutes(v1);
        registerGoalRoutes(v1);
        registerSubscriptionRoutes(v1);
        registerSupportRoutes(v1);
        registerDisputeRoutes(v1);
        registerMoneyRequestRoutes(v1);
        registerNotificationRoutes(v1);
        registerPushTokenRoutes(v1);
      },
      { prefix: "/v1" },
    );

    registerTxRoutes(app);

    if (options.proximityRoutes ?? config.enableProximityRoutes) {
      registerDeviceRoutes(app);
      registerTxCoseRoutes(app);
      registerSyncRoutes(app);
    }
  }

  // Errors are typed and surfaced, never swallowed (CLAUDE.md §8): logs the full
  // error server-side and returns a structured body, rather than Fastify's bare
  // default response or a silent 500 with no detail.
  //
  // Below 500, error.message is always OUR OWN typed message (a route
  // deliberately threw or replied with it) -- safe to echo back verbatim.
  // At/above 500 it's an unhandled exception, which in this codebase has
  // meant raw Postgres constraint text or a full zod issue dump reaching the
  // client (e.g. a duplicate-device_id PK violation, or an amount <= 0
  // tripping the DB's CHECK constraint before route-level validation caught
  // it) -- log the real error server-side, never echo it.
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      reply.status(statusCode).send({ error: "InternalError", message: "internal error" });
      return;
    }
    reply.status(statusCode).send({
      error: error.name || "InternalError",
      message: error.message,
    });
  });

  return app;
}
