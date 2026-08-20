import type { CommitResult } from "@tappay/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Counter } from "prom-client";

/** Shared by every route that settles money and needs both auth and a
 * per-account rate limit (transfers.ts, billPayments.ts) -- app.rateLimit
 * needs request.user.aid, which only exists once app.authenticate has
 * already run, so this must stay an explicit ordered array, not two
 * separately-declared preHandlers (see the original inline comment this
 * replaced in transfers.ts for the full reasoning, still accurate).
 * app.hasDecorator("rateLimit") is false only when buildApp({rateLimit:
 * false}) was used (every existing test file), in which case app.rateLimit
 * itself wouldn't exist to call. */
export function accountScopedRateLimitedPreHandlers(app: FastifyInstance, max: number) {
  return app.hasDecorator("rateLimit")
    ? [
        app.authenticate,
        app.rateLimit({
          max,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.user.aid,
        }),
      ]
    : [app.authenticate];
}

/** Shared 409-mapping for a failed bankAdapter.transfer() call. tx_uuid_conflict
 * is a security tripwire (CLAUDE.md §5), not a health metric -- its rate
 * should be flat zero; any nonzero rate means an attempted settlement-slot
 * hijack. */
export function sendSettlementFailure(
  reply: FastifyReply,
  result: Pick<CommitResult, "failureReason">,
  counter: Counter<"outcome">,
): FastifyReply {
  if (result.failureReason === "tx_uuid_conflict") {
    counter.inc({ outcome: "tx_uuid_conflict" });
    return reply.status(409).send({ error: "TxUuidConflict", message: "tx_uuid is already in use by a different transaction" });
  }
  if (result.failureReason === "reservation_expired") {
    counter.inc({ outcome: "reservation_expired" });
    return reply.status(409).send({ error: "ReservationExpired", message: result.failureReason });
  }
  counter.inc({ outcome: "insufficient_funds" });
  return reply.status(409).send({ error: "InsufficientFunds", message: result.failureReason });
}
