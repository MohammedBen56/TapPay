import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { db } from "../db/kysely.js";

const uuidParamSchema = z.string().uuid();

/** The two routes here are generic ledger reads with no proximity/COSE
 * dependency -- kept live for the v2 MVP while their P2P sibling
 * (POST /tx/submit) moved to parked/routes/tx-cose.ts. Both are slated for
 * replacement by Bearer-authenticated equivalents (GET /accounts/me/balance,
 * GET /transfers/:txUuid) once M1d lands; left in place unauthenticated until
 * then rather than removed outright, since nothing yet calls the replacement. */
export function registerTxRoutes(app: FastifyInstance): void {
  app.get("/accounts/:accountId/balance", async (request, reply) => {
    // Genuinely unauthenticated (D2, CLAUDE.md §11), not an authed route
    // missing its JWT-derived scoping; there is no request.user here to use
    // instead. Slated for replacement by GET /accounts/me/balance, per this
    // file's own module comment.
    const { accountId } = request.params as { accountId: string }; // nosemgrep: client-supplied-identifier
    const accountIdParsed = uuidParamSchema.safeParse(accountId);
    if (!accountIdParsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "accountId must be a UUID" });
    }
    const { currency } = request.query as { currency?: string };
    const balance = await bankAdapter.getAvailableBalance(accountId, currency ?? "MAD");
    return reply.send({ account_id: accountId, currency: currency ?? "MAD", available_balance: balance.toString() });
  });

  app.get("/tx/:txUuid/receipt", async (request, reply) => {
    const { txUuid } = request.params as { txUuid: string };
    const txUuidParsed = uuidParamSchema.safeParse(txUuid);
    if (!txUuidParsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "txUuid must be a UUID" });
    }
    const reservation = await db
      .selectFrom("reservations")
      .select(["state", "receipt_signature", "settled_at"])
      .where("tx_uuid", "=", txUuid)
      .executeTakeFirst();

    if (!reservation || reservation.state !== "COMMITTED" || !reservation.receipt_signature) {
      return reply.status(404).send({ error: "NotFound", message: "no settled receipt for this tx_uuid" });
    }

    return reply.send({
      tx_uuid: txUuid,
      settled_at: reservation.settled_at,
      receipt: Buffer.from(reservation.receipt_signature).toString("base64"),
    });
  });
}
