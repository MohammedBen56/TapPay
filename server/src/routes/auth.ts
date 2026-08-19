import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyPassword } from "../auth/passwords.js";
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken } from "../auth/refreshTokens.js";
import { config } from "../config.js";
import { db } from "../db/kysely.js";

const loginBodySchema = z.object({
  customer_id: z.string().min(1),
  password: z.string().min(1),
});
const refreshBodySchema = z.object({ refresh_token: z.string().min(1) });
const logoutBodySchema = z.object({ refresh_token: z.string().min(1) });

async function signAccessToken(
  app: FastifyInstance,
  params: { userId: string; accountId: string; customerId: string },
): Promise<string> {
  return app.jwt.sign(
    { sub: params.userId, aid: params.accountId, cid: params.customerId },
    // kid tags which signing key minted this token -- auth/plugin.ts's
    // resolveSecret reads it back on verify, which is the whole mechanism
    // that makes JWT_SECRET rotation possible without a hard cutover.
    { expiresIn: config.accessTokenTtlSeconds, kid: config.jwtSigningKeys[0].kid },
  );
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post(
    "/auth/login",
    { config: { rateLimit: { max: config.rateLimitLoginMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = loginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
      }
      const { customer_id, password } = parsed.data;

      // One generic response for every failure mode below -- unknown
      // customer_id, wrong password, locked account -- so the response
      // itself never discloses which case applies (no enumeration).
      const invalidCredentials = () =>
        reply.status(401).send({ error: "InvalidCredentials", message: "invalid customer ID or password" });

      const cred = await db
        .selectFrom("customer_credentials")
        .innerJoin("accounts", "accounts.user_id", "customer_credentials.user_id")
        .select([
          "customer_credentials.user_id",
          "customer_credentials.password_hash",
          "customer_credentials.failed_attempts",
          "customer_credentials.locked_until",
          "accounts.account_id",
        ])
        .where("customer_credentials.customer_id", "=", customer_id)
        .executeTakeFirst();

      if (!cred) {
        return invalidCredentials();
      }
      if (cred.locked_until && cred.locked_until.getTime() > Date.now()) {
        return invalidCredentials();
      }

      const passwordOk = await verifyPassword(cred.password_hash, password);
      if (!passwordOk) {
        const failedAttempts = cred.failed_attempts + 1;
        const lockedUntil =
          failedAttempts >= config.loginMaxFailedAttempts
            ? new Date(Date.now() + config.loginLockoutDurationSeconds * 1000)
            : null;
        await db
          .updateTable("customer_credentials")
          .set({ failed_attempts: failedAttempts, locked_until: lockedUntil })
          .where("customer_id", "=", customer_id)
          .execute();
        return invalidCredentials();
      }

      await db
        .updateTable("customer_credentials")
        .set({ failed_attempts: 0, locked_until: null })
        .where("customer_id", "=", customer_id)
        .execute();

      const [accessToken, refresh] = await Promise.all([
        signAccessToken(app, { userId: cred.user_id, accountId: cred.account_id, customerId: customer_id }),
        issueRefreshToken(cred.user_id),
      ]);

      return reply.send({
        access_token: accessToken,
        expires_in: config.accessTokenTtlSeconds,
        refresh_token: refresh.token,
        user: { customer_id, account_id: cred.account_id },
      });
    },
  );

  app.post("/auth/refresh", async (request, reply) => {
    const parsed = refreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }

    const result = await rotateRefreshToken(parsed.data.refresh_token);
    if (result.outcome !== "ok") {
      return reply.status(401).send({ error: "InvalidRefreshToken", message: "refresh token is invalid, expired, or revoked" });
    }

    const identity = await db
      .selectFrom("customer_credentials")
      .innerJoin("accounts", "accounts.user_id", "customer_credentials.user_id")
      .select(["customer_credentials.customer_id", "accounts.account_id"])
      .where("customer_credentials.user_id", "=", result.userId)
      .executeTakeFirstOrThrow();

    const accessToken = await signAccessToken(app, {
      userId: result.userId,
      accountId: identity.account_id,
      customerId: identity.customer_id,
    });

    return reply.send({
      access_token: accessToken,
      expires_in: config.accessTokenTtlSeconds,
      refresh_token: result.issued.token,
    });
  });

  app.post("/auth/logout", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = logoutBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    // 204 regardless of prior state (docs/TapPay_v2_Technical_Design.md §6) --
    // revokeRefreshToken is idempotent, so a retry or a token already revoked
    // by some other path is not an error from the client's point of view.
    await revokeRefreshToken(parsed.data.refresh_token);
    return reply.status(204).send();
  });
}
