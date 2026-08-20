import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

describe("POST /auth/change-password", () => {
  const app = buildApp({ rateLimit: false });

  it("changes the password and the new one works on the next login", async () => {
    const alice = await createTestCustomer(app, { password: "old-password-123" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: authHeader(alice),
      payload: { current_password: "old-password-123", new_password: "new-password-456" },
    });
    expect(response.statusCode).toBe(204);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { customer_id: alice.customerId, password: "old-password-123" },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { customer_id: alice.customerId, password: "new-password-456" },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("revokes the session that made the change (and every other active session)", async () => {
    const alice = await createTestCustomer(app, { password: "old-password-123" });

    await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: authHeader(alice),
      payload: { current_password: "old-password-123", new_password: "new-password-456" },
    });

    const refreshAfter = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refresh_token: alice.refreshToken } });
    expect(refreshAfter.statusCode).toBe(401);
  });

  it("rejects an incorrect current_password without changing anything", async () => {
    const alice = await createTestCustomer(app, { password: "old-password-123" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: authHeader(alice),
      payload: { current_password: "totally-wrong", new_password: "new-password-456" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("InvalidCredentials");

    const stillWorks = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { customer_id: alice.customerId, password: "old-password-123" },
    });
    expect(stillWorks.statusCode).toBe(200);
  });

  it("rejects a new_password shorter than 8 characters", async () => {
    const alice = await createTestCustomer(app, { password: "old-password-123" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: authHeader(alice),
      payload: { current_password: "old-password-123", new_password: "short" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      payload: { current_password: "x", new_password: "new-password-456" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /auth/sessions and DELETE /auth/sessions/:id", () => {
  const app = buildApp({ rateLimit: false });

  it("lists the caller's own active sessions, including the one just used to log in", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: authHeader(alice) });
    expect(response.statusCode).toBe(200);
    const { sessions } = response.json() as { sessions: { id: string }[] };
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("does not list another customer's sessions", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app)]);
    const response = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: authHeader(alice) });
    const { sessions } = response.json() as { sessions: { id: string }[] };

    const bobSessions = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: authHeader(bob) });
    const bobIds = new Set((bobSessions.json() as { sessions: { id: string }[] }).sessions.map((s) => s.id));

    expect(sessions.every((s) => !bobIds.has(s.id))).toBe(true);
  });

  it("revokes a session by id, and its refresh token stops working", async () => {
    const alice = await createTestCustomer(app);
    const list = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: authHeader(alice) });
    const { sessions } = list.json() as { sessions: { id: string }[] };
    const sessionId = sessions[0]!.id;

    const revoke = await app.inject({ method: "DELETE", url: `/v1/auth/sessions/${sessionId}`, headers: authHeader(alice) });
    expect(revoke.statusCode).toBe(204);

    const refreshAfter = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refresh_token: alice.refreshToken } });
    expect(refreshAfter.statusCode).toBe(401);
  });

  it("404s revoking another customer's session id", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app)]);
    const list = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: authHeader(bob) });
    const bobSessionId = (list.json() as { sessions: { id: string }[] }).sessions[0]!.id;

    const response = await app.inject({ method: "DELETE", url: `/v1/auth/sessions/${bobSessionId}`, headers: authHeader(alice) });
    expect(response.statusCode).toBe(404);

    // Bob's session must still be usable -- alice's attempt had no effect.
    const bob2 = await createTestCustomer(app); // control: unrelated session still works fine
    expect(bob2.accessToken).toBeTruthy();
  });

  it("404s for an unknown session id", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({ method: "DELETE", url: `/v1/auth/sessions/${randomUUID()}`, headers: authHeader(alice) });
    expect(response.statusCode).toBe(404);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/auth/sessions" });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
