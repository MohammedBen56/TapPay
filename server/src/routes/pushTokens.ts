import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/kysely.js";

export const registerPushTokenBodySchema = z.object({
  token: z.string().min(1).max(400),
  platform: z.enum(["android", "ios"]),
});

/**
 * Ship List v2 Wave 2 Phase 8: registers (or refreshes) the caller's own
 * Expo push token, called at login/app-foreground (mobile/src/push/
 * pushToken.ts). See server/src/notifications.ts's header comment for the
 * real boundary on when a device will ever actually have a token to
 * register (an EAS project id this repo doesn't have yet).
 */
export function registerPushTokenRoutes(app: FastifyInstance): void {
  app.post("/push-tokens", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = registerPushTokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { sub: userId } = request.user;
    const { token, platform } = parsed.data;

    await db
      .insertInto("push_tokens")
      .values({ user_id: userId, token, platform })
      .onConflict((oc) => oc.columns(["user_id", "token"]).doUpdateSet({ platform, updated_at: new Date() }))
      .execute();

    return reply.status(204).send();
  });
}
