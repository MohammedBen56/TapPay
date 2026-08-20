import { randomInt } from "node:crypto";
import { buildRib } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { recordAudit } from "../audit/log.js";
import { db } from "../db/kysely.js";

// `savings` is the only client-choosable account_type -- `checking` always
// exists already (provisioned at signup, seed.ts/the parked enroll flow),
// so there is no "open a checking account" action for a client to invoke.
const openAccountBodySchema = z.object({ account_type: z.literal("savings") });

/** Same randomness shape as v2TestHelpers.ts's randomBranchAndAccount() and
 * seed.ts's demo RIBs -- a fresh 3-digit branch + 16-digit account number,
 * collision-negligible at this app's scale, self-checked by buildRib's own
 * mod-97-10 digits. */
function freshRib(): string {
  const branch = randomInt(0, 999).toString().padStart(3, "0");
  let account = "";
  for (let i = 0; i < 16; i++) account += randomInt(0, 10).toString();
  return buildRib(branch, account);
}

/** Ship List v2 Phase 8: a customer's own accounts (checking, and savings
 * once opened). Always scoped from the JWT's `sub`, never a client-supplied
 * id -- same pattern as every other authed route in this file's siblings. */
export function registerAccountRoutes(app: FastifyInstance): void {
  app.get("/accounts", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId } = request.user;
    const rows = await db
      .selectFrom("accounts")
      .select(["account_id", "account_type", "rib", "currency"])
      .where("user_id", "=", userId)
      .orderBy("account_type")
      .execute();

    const accounts = await Promise.all(
      rows.map(async (r) => ({
        account_id: r.account_id,
        account_type: r.account_type,
        rib: r.rib,
        currency: r.currency,
        available_balance: (await bankAdapter.getAvailableBalance(r.account_id, r.currency)).toString(),
      })),
    );

    return reply.send({ accounts });
  });

  app.post("/accounts", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = openAccountBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { sub: userId } = request.user;
    const { account_type } = parsed.data;

    try {
      const row = await db
        .insertInto("accounts")
        .values({ user_id: userId, account_type, rib: freshRib(), currency: "MAD" })
        .returning(["account_id", "account_type", "rib", "currency"])
        .executeTakeFirstOrThrow();
      await recordAudit({ userId, action: "account.open", resourceType: "account", resourceId: row.account_id, ip: request.ip });
      return reply.status(201).send({
        account_id: row.account_id,
        account_type: row.account_type,
        rib: row.rib,
        currency: row.currency,
        available_balance: "0",
      });
    } catch (err) {
      // UNIQUE (user_id, account_type) -- Postgres unique_violation.
      if ((err as { code?: string }).code === "23505") {
        return reply.status(409).send({ error: "DuplicateAccount", message: "you already have an account of this type" });
      }
      throw err;
    }
  });
}
