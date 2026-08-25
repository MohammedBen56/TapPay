import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { recordAudit } from "../audit/log.js";
import { db } from "../db/kysely.js";
import { resolveAccountByType } from "./accountSelection.js";

export const createGoalBodySchema = z.object({
  name: z.string().trim().min(1).max(140),
  // Minor-units decimal string, matching every other money field on the
  // wire (CLAUDE.md §5 -- never a JSON number for money).
  target_amount: z.string().regex(/^\d+$/, "target_amount must be a positive integer minor-units string"),
  target_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "target_date must be YYYY-MM-DD")
    .optional(),
});

export const fundGoalBodySchema = z.object({
  amount: z.string().regex(/^\d+$/, "amount must be a positive integer minor-units string"),
});

/**
 * Ship List v2 Wave 2 Phase 5: financial goals/vaults. A goal earmarks an
 * amount INSIDE the customer's one real savings account rather than owning
 * its own ledger account (migration 026_goals.cjs's own comment has the
 * full reasoning) -- funding a goal is a pure bookkeeping increment to
 * `saved_amount`, never a `bankAdapter.transfer()` call, since the money
 * already sits in savings. Always scoped by `owner_user_id` from the JWT's
 * `sub`, same client-suppliable-identifier pattern as beneficiaries.ts.
 *
 * **Overfund/double-earmark check** (found via critical self-review, not
 * scoped in the original phase plan): the first draft let `saved_amount`
 * grow unconditionally, so a user could "earmark" more across their goals
 * than actually sits in savings -- the UI would show real-looking progress
 * bars for money that was never there. `/goals/:id/fund` now checks the
 * real savings balance (`bankAdapter.getAvailableBalance()`) against the
 * SUM of the user's own `goals.saved_amount` (including this fund) before
 * committing. Deliberately NOT advisory-locked like `transfers.ts`'s
 * velocity cap: this is bookkeeping over money that never moves (no ledger
 * row, no double-spend risk) -- a race between two concurrent funds could
 * still let the displayed total drift slightly ahead of the real balance
 * for one request's window, an accepted, low-stakes gap given nothing here
 * can debit an account past its real balance.
 */
export function registerGoalRoutes(app: FastifyInstance): void {
  app.get("/goals", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId } = request.user;
    const rows = await db
      .selectFrom("goals")
      .select(["id", "name", "target_amount", "saved_amount", "target_date", "created_at"])
      .where("owner_user_id", "=", userId)
      .orderBy("created_at")
      .execute();
    return reply.send({
      goals: rows.map((r) => ({
        id: r.id,
        name: r.name,
        target_amount: r.target_amount.toString(),
        saved_amount: r.saved_amount.toString(),
        target_date: r.target_date,
        created_at: r.created_at.toISOString(),
      })),
    });
  });

  app.post("/goals", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = createGoalBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { sub: userId } = request.user;
    const targetAmount = BigInt(parsed.data.target_amount);
    if (targetAmount <= 0n) {
      return reply.status(400).send({ error: "InvalidAmount", message: "target_amount must be positive" });
    }

    const row = await db
      .insertInto("goals")
      .values({
        owner_user_id: userId,
        name: parsed.data.name,
        target_amount: targetAmount,
        target_date: parsed.data.target_date ?? null,
      })
      .returning(["id", "name", "target_amount", "saved_amount", "target_date", "created_at"])
      .executeTakeFirstOrThrow();
    await recordAudit({ userId, action: "goal.create", resourceType: "goal", resourceId: row.id, ip: request.ip });

    return reply.status(201).send({
      id: row.id,
      name: row.name,
      target_amount: row.target_amount.toString(),
      saved_amount: row.saved_amount.toString(),
      target_date: row.target_date,
      created_at: row.created_at.toISOString(),
    });
  });

  // Bookkeeping only -- increments saved_amount, no money movement. The
  // DB's own CHECK (saved_amount >= 0) is the backstop; this also rejects
  // a non-positive fund amount before touching the row.
  app.post("/goals/:id/fund", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "id must be a UUID" });
    }
    const parsed = fundGoalBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { sub: userId } = request.user;
    const amount = BigInt(parsed.data.amount);
    if (amount <= 0n) {
      return reply.status(400).send({ error: "InvalidAmount", message: "amount must be positive" });
    }

    const savingsAccount = await resolveAccountByType(userId, "savings");
    if (!savingsAccount) {
      return reply.status(404).send({ error: "NoSavingsAccount", message: "open a savings account before funding a goal" });
    }
    const [savingsBalance, earmarked] = await Promise.all([
      bankAdapter.getAvailableBalance(savingsAccount.account_id, savingsAccount.currency),
      db
        .selectFrom("goals")
        .select((eb) => eb.fn.coalesce(eb.fn.sum<bigint>("saved_amount"), eb.lit(0)).as("total"))
        .where("owner_user_id", "=", userId)
        .executeTakeFirstOrThrow(),
    ]);
    if (BigInt(earmarked.total) + amount > savingsBalance) {
      return reply
        .status(400)
        .send({ error: "InsufficientSavings", message: "this would earmark more than your real savings balance" });
    }

    const updated = await db
      .updateTable("goals")
      .set((eb) => ({ saved_amount: eb("saved_amount", "+", amount) }))
      .where("id", "=", id)
      .where("owner_user_id", "=", userId)
      .returning(["id", "name", "target_amount", "saved_amount", "target_date", "created_at"])
      .executeTakeFirst();

    if (!updated) {
      return reply.status(404).send({ error: "NotFound", message: "goal not found" });
    }
    await recordAudit({ userId, action: "goal.fund", resourceType: "goal", resourceId: id, ip: request.ip });

    return reply.send({
      id: updated.id,
      name: updated.name,
      target_amount: updated.target_amount.toString(),
      saved_amount: updated.saved_amount.toString(),
      target_date: updated.target_date,
      created_at: updated.created_at.toISOString(),
    });
  });

  app.delete("/goals/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "id must be a UUID" });
    }
    const { sub: userId } = request.user;

    const deleted = await db.deleteFrom("goals").where("id", "=", id).where("owner_user_id", "=", userId).executeTakeFirst();
    if (deleted.numDeletedRows === 0n) {
      return reply.status(404).send({ error: "NotFound", message: "goal not found" });
    }
    await recordAudit({ userId, action: "goal.delete", resourceType: "goal", resourceId: id, ip: request.ip });
    return reply.status(204).send();
  });
}
