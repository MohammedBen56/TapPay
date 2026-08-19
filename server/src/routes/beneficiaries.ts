import { isValidRib } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/kysely.js";

const createBodySchema = z.object({
  display_name: z.string().trim().min(1).max(140),
  rib: z.string(),
});
const updateBodySchema = z.object({
  display_name: z.string().trim().min(1).max(140),
});

/** Saved recipients for the Send flow. Always scoped by the token's
 * `owner_user_id` (`request.user.sub`), never a value from the request body
 * or params -- CLAUDE.md §10's client-suppliable-identifier pattern applies
 * here just as much as it did to device_id/tx_uuid in the parked P2P code. */
export function registerBeneficiaryRoutes(app: FastifyInstance): void {
  app.get("/beneficiaries", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId } = request.user;
    const rows = await db
      .selectFrom("beneficiaries")
      .select(["id", "display_name", "rib"])
      .where("owner_user_id", "=", userId)
      .orderBy("display_name")
      .execute();
    return reply.send({ beneficiaries: rows });
  });

  app.post("/beneficiaries", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { display_name, rib } = parsed.data;
    const { sub: userId, aid: accountId } = request.user;

    if (!isValidRib(rib)) {
      return reply.status(400).send({ error: "InvalidRib", message: "rib is not a valid RIB" });
    }
    const target = await db.selectFrom("accounts").select(["account_id"]).where("rib", "=", rib).executeTakeFirst();
    if (!target) {
      return reply.status(404).send({ error: "UnknownRecipient", message: "no account with this RIB" });
    }
    if (target.account_id === accountId) {
      return reply.status(400).send({ error: "SelfPayment", message: "cannot add yourself as a beneficiary" });
    }

    try {
      const row = await db
        .insertInto("beneficiaries")
        .values({ owner_user_id: userId, display_name, rib })
        .returning(["id"])
        .executeTakeFirstOrThrow();
      return reply.status(201).send({ id: row.id, display_name, rib });
    } catch (err) {
      // UNIQUE (owner_user_id, rib) -- Postgres unique_violation.
      if ((err as { code?: string }).code === "23505") {
        return reply.status(409).send({ error: "DuplicateBeneficiary", message: "this RIB is already saved" });
      }
      throw err;
    }
  });

  app.patch("/beneficiaries/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "id must be a UUID" });
    }
    const parsed = updateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { sub: userId } = request.user;

    const updated = await db
      .updateTable("beneficiaries")
      .set({ display_name: parsed.data.display_name })
      .where("id", "=", id)
      .where("owner_user_id", "=", userId)
      .returning(["id", "display_name", "rib"])
      .executeTakeFirst();

    if (!updated) {
      return reply.status(404).send({ error: "NotFound", message: "beneficiary not found" });
    }
    return reply.send(updated);
  });

  app.delete("/beneficiaries/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "id must be a UUID" });
    }
    const { sub: userId } = request.user;

    const deleted = await db
      .deleteFrom("beneficiaries")
      .where("id", "=", id)
      .where("owner_user_id", "=", userId)
      .executeTakeFirst();

    if (deleted.numDeletedRows === 0n) {
      return reply.status(404).send({ error: "NotFound", message: "beneficiary not found" });
    }
    return reply.status(204).send();
  });
}
