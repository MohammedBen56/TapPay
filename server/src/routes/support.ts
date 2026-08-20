import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordAudit } from "../audit/log.js";
import { db } from "../db/kysely.js";

export const createSupportRequestBodySchema = z.object({
  subject: z.string().trim().min(1).max(140),
  message: z.string().trim().min(1).max(4000),
});

/**
 * Ship List v2 Wave 2 Phase 6: in-app support/FAQ's contact-form half. A
 * real stored request, not a `mailto:` link -- the caller can see their
 * own past requests, and a human operator reviews `support_requests`
 * directly (docs/INCIDENT_RESPONSE.md's single-owner reality; no admin
 * reply flow yet). Always scoped by the JWT's `sub`, same
 * client-suppliable-identifier discipline as beneficiaries.ts/goals.ts.
 */
export function registerSupportRoutes(app: FastifyInstance): void {
  app.get("/support-requests", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId } = request.user;
    const rows = await db
      .selectFrom("support_requests")
      .select(["id", "subject", "message", "status", "created_at"])
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .execute();
    return reply.send({
      support_requests: rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        message: r.message,
        status: r.status,
        created_at: r.created_at.toISOString(),
      })),
    });
  });

  app.post("/support-requests", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = createSupportRequestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { sub: userId } = request.user;

    const row = await db
      .insertInto("support_requests")
      .values({ user_id: userId, subject: parsed.data.subject, message: parsed.data.message })
      .returning(["id", "subject", "message", "status", "created_at"])
      .executeTakeFirstOrThrow();
    await recordAudit({ userId, action: "support_request.create", resourceType: "support_request", resourceId: row.id, ip: request.ip });

    return reply.status(201).send({
      id: row.id,
      subject: row.subject,
      message: row.message,
      status: row.status,
      created_at: row.created_at.toISOString(),
    });
  });
}
