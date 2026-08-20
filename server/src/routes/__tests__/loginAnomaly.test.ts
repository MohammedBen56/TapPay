import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { createTestCustomer } from "./v2TestHelpers.js";

/** Ship List v2 Wave 2 Phase 4: login-anomaly signal
 * (deviceFingerprint.ts, wired into routes/auth.ts's login route). A
 * review-workflow flag, not a block -- these tests assert the audit_log
 * entry and known_devices bookkeeping, not that login is ever refused. */
describe("login-anomaly signal (known_devices / login.new_device)", () => {
  const app = buildApp({ rateLimit: false });

  it("flags the first login from a given fingerprint as login.new_device, and does not re-flag a repeat login from the same one", async () => {
    // createTestCustomer's own login call already establishes the IP
    // fallback fingerprint (no X-Device-Id header, matching how the test
    // harness's app.inject() calls work) as "known" for this user.
    const alice = await createTestCustomer(app, { password: "anomaly-test-pw-1" });

    const firstLoginFlags = await db
      .selectFrom("audit_log")
      .select(["action"])
      .where("user_id", "=", alice.userId)
      .where("action", "=", "login.new_device")
      .execute();
    expect(firstLoginFlags).toHaveLength(1);

    await app.inject({ method: "POST", url: "/v1/auth/login", payload: { customer_id: alice.customerId, password: alice.password } });

    const afterRepeatLogin = await db
      .selectFrom("audit_log")
      .select(["action"])
      .where("user_id", "=", alice.userId)
      .where("action", "=", "login.new_device")
      .execute();
    // Still exactly one -- the repeat login used the same (IP-fallback)
    // fingerprint, so it's already in known_devices.
    expect(afterRepeatLogin).toHaveLength(1);

    const knownDevices = await db.selectFrom("known_devices").select(["user_id"]).where("user_id", "=", alice.userId).execute();
    expect(knownDevices).toHaveLength(1);
  });

  it("flags a login carrying a distinct X-Device-Id header as a second, separate login.new_device", async () => {
    const bob = await createTestCustomer(app, { password: "anomaly-test-pw-2" });

    await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { customer_id: bob.customerId, password: bob.password },
      headers: { "x-device-id": "test-fixture-device-id" },
    });

    const flags = await db
      .selectFrom("audit_log")
      .select(["action"])
      .where("user_id", "=", bob.userId)
      .where("action", "=", "login.new_device")
      .execute();
    // One for createTestCustomer's own IP-fallback login, one for this
    // distinct X-Device-Id login -- two genuinely different fingerprints.
    expect(flags).toHaveLength(2);

    const knownDevices = await db.selectFrom("known_devices").select(["user_id"]).where("user_id", "=", bob.userId).execute();
    expect(knownDevices).toHaveLength(2);
  });
});
