import { isValidRib } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { db } from "../db/kysely.js";

/** Pre-send validation for "type bank details manually" -- confirms a RIB
 * resolves to a real account and shows the holder's name before the user
 * commits to sending. Real information-disclosure surface by design (that's
 * the whole point), so: syntactic rejection before any query, authenticated,
 * and tightly rate-limited (docs/TapPay_v2_Technical_Design.md §3). */
export function registerLookupRoutes(app: FastifyInstance): void {
  app.get(
    "/lookup/rib/:rib",
    { preHandler: [app.authenticate], config: { rateLimit: { max: config.rateLimitRibLookupMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { rib } = request.params as { rib: string };
      if (!isValidRib(rib)) {
        return reply.status(404).send({ error: "NotFound", message: "no account with this RIB" });
      }
      const account = await db
        .selectFrom("accounts")
        .innerJoin("users", "users.user_id", "accounts.user_id")
        .select(["users.display_name as display_name"])
        .where("rib", "=", rib)
        .executeTakeFirst();
      if (!account || !account.display_name) {
        return reply.status(404).send({ error: "NotFound", message: "no account with this RIB" });
      }
      return reply.send({ rib, display_name: account.display_name });
    },
  );
}
