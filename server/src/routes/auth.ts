import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordAudit } from "../audit/log.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import {
  issueRefreshToken,
  listActiveSessions,
  revokeAllSessionsForUser,
  revokeFamily,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../auth/refreshTokens.js";
import { config } from "../config.js";
import { db } from "../db/kysely.js";

export const loginBodySchema = z.object({
  customer_id: z.string().min(1),
  password: z.string().min(1),
});
export const refreshBodySchema = z.object({ refresh_token: z.string().min(1) });
export const logoutBodySchema = z.object({ refresh_token: z.string().min(1) });
export const changePasswordBodySchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, "new_password must be at least 8 characters"),
});

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
        // Ship List v2 Phase 8: a customer can now own more than one
        // accounts row (checking + savings) -- without this, the JWT's
        // `aid` claim would bind non-deterministically to whichever row
        // Postgres happened to return first. `aid` always means checking;
        // account selection for the rest is via accountSelection.ts's
        // explicit ?account_id=, never the JWT claim itself.
        .where("accounts.account_type", "=", "checking")
        .executeTakeFirst();

      if (!cred) {
        // No resolvable user_id -- the customer_id itself doesn't exist.
        // Still worth recording: repeated unknown-customer_id attempts
        // from one IP is exactly the pattern a security review would want
        // to find in this trail.
        await recordAudit({ userId: null, action: "login.failure", resourceType: "customer_id", resourceId: customer_id, ip: request.ip });
        return invalidCredentials();
      }
      if (cred.locked_until && cred.locked_until.getTime() > Date.now()) {
        await recordAudit({ userId: cred.user_id, action: "login.failure", resourceType: "account", ip: request.ip });
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
        await recordAudit({ userId: cred.user_id, action: "login.failure", resourceType: "account", ip: request.ip });
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
      await recordAudit({ userId: cred.user_id, action: "login.success", resourceType: "account", ip: request.ip });

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
      // Same Ship List v2 Phase 8 fix as /auth/login above -- `aid` always
      // means checking.
      .where("accounts.account_type", "=", "checking")
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
    await recordAudit({ userId: request.user.sub, action: "logout", resourceType: "account", ip: request.ip });
    return reply.status(204).send();
  });

  // Ship List v2 -- routine password hygiene, independent of D6's "no
  // forgot-password recovery flow" (CLAUDE.md §11): this is for a signed-in
  // customer who already knows their current password, not account
  // recovery. Revokes every active session for the user afterward
  // (refreshTokens.ts's revokeAllSessionsForUser doc comment has the
  // reasoning) -- the client that just changed the password gets signed
  // out too and must sign back in with the new one, same as every other
  // client.
  app.post("/auth/change-password", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = changePasswordBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { current_password, new_password } = parsed.data;
    const { sub: userId } = request.user;

    const cred = await db
      .selectFrom("customer_credentials")
      .select(["password_hash"])
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();

    const currentOk = await verifyPassword(cred.password_hash, current_password);
    if (!currentOk) {
      return reply.status(401).send({ error: "InvalidCredentials", message: "current password is incorrect" });
    }

    const newHash = await hashPassword(new_password);
    await db.updateTable("customer_credentials").set({ password_hash: newHash }).where("user_id", "=", userId).execute();
    await revokeAllSessionsForUser(userId);
    await recordAudit({ userId, action: "password.change", resourceType: "account", ip: request.ip });

    return reply.status(204).send();
  });

  // Ship List v2 -- auth_sessions (migration 014) already tracks every
  // active login with full rotation/theft-detection; this just exposes
  // it. One row per active session (a family's older, already-rotated-away
  // rows already carry their own revoked_at, so no extra filtering is
  // needed to collapse rotation history down to "current sessions").
  app.get("/auth/sessions", { preHandler: [app.authenticate] }, async (request, reply) => {
    const sessions = await listActiveSessions(request.user.sub);
    return reply.send({
      sessions: sessions.map((s) => ({ id: s.id, issued_at: s.issuedAt.toISOString(), expires_at: s.expiresAt.toISOString() })),
    });
  });

  app.delete("/auth/sessions/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "id must be a UUID" });
    }
    const { sub: userId } = request.user;

    // Ownership check before revoking anything -- CLAUDE.md §10's
    // client-suppliable-identifier pattern: id is chosen by the client
    // (it's just echoing a value GET /auth/sessions returned), so it must
    // never be trusted without confirming it actually belongs to the
    // caller.
    const session = await db
      .selectFrom("auth_sessions")
      .select(["family_id"])
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!session) {
      return reply.status(404).send({ error: "NotFound", message: "session not found" });
    }

    await revokeFamily(session.family_id);
    await recordAudit({ userId, action: "session.revoke", resourceType: "session", resourceId: id, ip: request.ip });
    return reply.status(204).send();
  });
}
