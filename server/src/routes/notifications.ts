import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/kysely.js";

// Defensive cap, same pattern as DATA_EXPORT_ROW_CAP/STATEMENT_ROW_CAP --
// the notification center is a recent-activity feed, not a full archive.
const NOTIFICATIONS_LIST_CAP = 100;

/**
 * Ship List v2 Wave 2 Phase 8: the in-app notification center. Always
 * scoped by the JWT's `sub` -- every row here was written by
 * `notifications.ts`'s `notify()` for this exact user_id, so there's no
 * client-suppliable-identifier surface on the list route; `:id/read`
 * still checks ownership before touching a row, same as every other
 * client-chosen-identifier route in this codebase (CLAUDE.md §10).
 */
export function registerNotificationRoutes(app: FastifyInstance): void {
  app.get("/notifications", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId } = request.user;
    const rows = await db
      .selectFrom("notifications")
      .select(["id", "title", "body", "data", "read_at", "created_at"])
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .limit(NOTIFICATIONS_LIST_CAP)
      .execute();

    return reply.send({
      notifications: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        data: r.data,
        read_at: r.read_at ? r.read_at.toISOString() : null,
        created_at: r.created_at.toISOString(),
      })),
    });
  });

  app.post("/notifications/:id/read", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "id must be a UUID" });
    }
    const { sub: userId } = request.user;

    // Idempotent: not found, not the caller's, or already read are all a
    // no-op 204 -- no existence-leak, matching the RIB-lookup/beneficiary
    // pattern elsewhere in this codebase.
    await db
      .updateTable("notifications")
      .set({ read_at: new Date() })
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .where("read_at", "is", null)
      .execute();
    return reply.status(204).send();
  });
}
