import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

describe("push tokens + in-app notifications (Ship List v2 Wave 2 Phase 8)", () => {
  const app = buildApp({ rateLimit: false });

  it("registers a push token idempotently (re-registering the same token updates, not duplicates)", async () => {
    const alice = await createTestCustomer(app);
    const first = await app.inject({
      method: "POST",
      url: "/v1/push-tokens",
      headers: authHeader(alice),
      payload: { token: "ExponentPushToken[test-1]", platform: "android" },
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: "POST",
      url: "/v1/push-tokens",
      headers: authHeader(alice),
      payload: { token: "ExponentPushToken[test-1]", platform: "android" },
    });
    expect(second.statusCode).toBe(204);

    const rows = await db.selectFrom("push_tokens").select(["id"]).where("user_id", "=", alice.userId).execute();
    expect(rows).toHaveLength(1);
  });

  it("rejects an invalid platform", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/push-tokens",
      headers: authHeader(alice),
      payload: { token: "x", platform: "windows-phone" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("a money request creates an in-app notification for the target, and fulfilling it notifies the requester", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app, { startingBalance: 10_000n })]);

    const create = await app.inject({
      method: "POST",
      url: "/v1/money-requests",
      headers: authHeader(alice),
      payload: { to_rib: bob.rib, amount: "1000", currency: "MAD", reference: "Notif test" },
    });
    const requestId = create.json().id as string;

    const bobNotifications = await app.inject({ method: "GET", url: "/v1/notifications", headers: authHeader(bob) });
    expect(bobNotifications.json().notifications).toHaveLength(1);
    expect(bobNotifications.json().notifications[0]).toMatchObject({ title: "Money request", read_at: null });
    expect(bobNotifications.json().notifications[0].body).toContain("10.00 MAD");

    await app.inject({ method: "POST", url: `/v1/money-requests/${requestId}/fulfill`, headers: authHeader(bob) });

    const aliceNotifications = await app.inject({ method: "GET", url: "/v1/notifications", headers: authHeader(alice) });
    expect(aliceNotifications.json().notifications).toHaveLength(1);
    expect(aliceNotifications.json().notifications[0]).toMatchObject({ title: "Request paid" });
  });

  it("marking a notification read is idempotent and scoped to the caller", async () => {
    const [alice, bob, mallory] = await Promise.all([
      createTestCustomer(app),
      createTestCustomer(app, { startingBalance: 10_000n }),
      createTestCustomer(app),
    ]);
    await app.inject({
      method: "POST",
      url: "/v1/money-requests",
      headers: authHeader(alice),
      payload: { to_rib: bob.rib, amount: "500", currency: "MAD", reference: "test" },
    });
    const bobNotifications = await app.inject({ method: "GET", url: "/v1/notifications", headers: authHeader(bob) });
    const notificationId = bobNotifications.json().notifications[0].id as string;

    // Another customer marking it read is a silent no-op (no existence-leak).
    const malloryMark = await app.inject({ method: "POST", url: `/v1/notifications/${notificationId}/read`, headers: authHeader(mallory) });
    expect(malloryMark.statusCode).toBe(204);
    const stillUnread = await app.inject({ method: "GET", url: "/v1/notifications", headers: authHeader(bob) });
    expect(stillUnread.json().notifications[0].read_at).toBeNull();

    const bobMark = await app.inject({ method: "POST", url: `/v1/notifications/${notificationId}/read`, headers: authHeader(bob) });
    expect(bobMark.statusCode).toBe(204);
    const nowRead = await app.inject({ method: "GET", url: "/v1/notifications", headers: authHeader(bob) });
    expect(nowRead.json().notifications[0].read_at).not.toBeNull();

    // Re-marking an already-read notification is still a clean 204.
    const again = await app.inject({ method: "POST", url: `/v1/notifications/${notificationId}/read`, headers: authHeader(bob) });
    expect(again.statusCode).toBe(204);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/notifications" });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
