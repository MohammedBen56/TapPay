/**
 * Pino configuration for Fastify's `logger` option (app.ts) and for the
 * sweeper's own logging (sweeper.ts, index.ts), so both go through the same
 * redaction and req-id discipline rather than the sweeper's previous plain
 * `console.error` bypassing the logger entirely.
 *
 * Two layers, deliberately: an ALLOW-list on req/res serializers (only the
 * fields named below are ever emitted -- a new field added to a request
 * object later leaks nothing by default), plus `redact` as a second,
 * defense-in-depth layer for anything logged outside those serializers.
 * A deny-list alone fails open on any field nobody thought to add; this
 * doesn't.
 */
import type { FastifyServerOptions } from "fastify";

export const loggerOptions: FastifyServerOptions["logger"] = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "*.password",
      "token",
      "*.token",
      "refresh_token",
      "*.refresh_token",
      "access_token",
      "*.access_token",
      "token_hash",
      "*.token_hash",
    ],
    remove: true,
  },
  serializers: {
    req(request) {
      return {
        method: request.method,
        // routeOptions.url is the route PATTERN ("/transfers/:txUuid"), not
        // the resolved path with real params -- request.url can carry a
        // customer-typed RIB or tx_uuid in the path itself, which this
        // serializer deliberately never emits.
        url: request.routeOptions?.url,
        reqId: request.id,
      };
    },
    res(reply) {
      return {
        statusCode: reply.statusCode,
      };
    },
  },
  genReqId(request) {
    const inbound = request.headers["x-request-id"];
    return typeof inbound === "string" && inbound.length > 0 ? inbound : crypto.randomUUID();
  },
};

/** Money crossing a log line as a JSON number risks float rounding the
 * instant any downstream log tool re-parses it -- render it as an explicit
 * string tuple instead, restating the ledger's bigint-only invariant a third
 * time in the codebase (alongside the DB type parser in db/kysely.ts and the
 * TypeScript `bigint` column types themselves). Use as
 * `app.log.info({ amount: moneyLogField(amountBigint, "MAD") }, "...")`. */
export function moneyLogField(minorUnits: bigint, currency: string): { minor: string; currency: string } {
  return { minor: minorUnits.toString(), currency };
}
