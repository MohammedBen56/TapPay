import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordAudit } from "../audit/log.js";
import { db } from "../db/kysely.js";

export const createDisputeBodySchema = z.object({
  tx_uuid: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});

/**
 * Ship List v2 Wave 2 Phase 6: "flag this transaction" off the receipt
 * screen. NEVER touches money movement -- a review request, not a
 * reversal mechanism; `status` starts and stays `open` until reviewed
 * out-of-band (docs/INCIDENT_RESPONSE.md's single-owner reality).
 *
 * `tx_uuid` is a client-chosen identifier naming a transaction the
 * caller wants to flag -- CLAUDE.md §10's rule for this pattern applies:
 * ownership is verified against the SAME `journal` join
 * `GET /transfers/:txUuid` already uses (any of the caller's own
 * accounts, not just the JWT's `aid`) before a dispute can even be filed,
 * never trusted bare.
 */
export function registerDisputeRoutes(app: FastifyInstance): void {
  app.get("/disputes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId } = request.user;
    const rows = await db
      .selectFrom("disputes")
      .select(["id", "tx_uuid", "reason", "status", "created_at"])
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .execute();
    return reply.send({
      disputes: rows.map((r) => ({
        id: r.id,
        tx_uuid: r.tx_uuid,
        reason: r.reason,
        status: r.status,
        created_at: r.created_at.toISOString(),
      })),
    });
  });

  app.post("/disputes", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = createDisputeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { sub: userId } = request.user;
    const { tx_uuid, reason } = parsed.data;

    // Same ownership join as GET /transfers/:txUuid -- a dispute can only
    // be filed against a transaction one of the caller's OWN accounts
    // (checking or savings) actually participated in.
    const owns = await db
      .selectFrom("journal as j")
      .innerJoin("accounts as own", (join) => join.onRef("own.account_id", "=", "j.account_id").on("own.user_id", "=", userId))
      .select("j.tx_uuid")
      .where("j.tx_uuid", "=", tx_uuid)
      .executeTakeFirst();
    if (!owns) {
      return reply.status(404).send({ error: "NotFound", message: "no transaction with this tx_uuid for your account" });
    }

    try {
      const row = await db
        .insertInto("disputes")
        .values({ user_id: userId, tx_uuid, reason })
        .returning(["id", "tx_uuid", "reason", "status", "created_at"])
        .executeTakeFirstOrThrow();
      await recordAudit({ userId, action: "dispute.create", resourceType: "dispute", resourceId: row.id, ip: request.ip });
      return reply.status(201).send({
        id: row.id,
        tx_uuid: row.tx_uuid,
        reason: row.reason,
        status: row.status,
        created_at: row.created_at.toISOString(),
      });
    } catch (err) {
      // UNIQUE (user_id, tx_uuid) -- Postgres unique_violation.
      if ((err as { code?: string }).code === "23505") {
        return reply.status(409).send({ error: "DuplicateDispute", message: "you've already flagged this transaction" });
      }
      throw err;
    }
  });
}
