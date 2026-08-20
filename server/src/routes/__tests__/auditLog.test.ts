import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

describe("audit log", () => {
  const app = buildApp({ rateLimit: false });

  it("records a successful login with the resolved user_id", async () => {
    const alice = await createTestCustomer(app, { password: "audit-test-pw-1" });
    const rows = await db
      .selectFrom("audit_log")
      .select(["action", "user_id"])
      .where("user_id", "=", alice.userId)
      .where("action", "=", "login.success")
      .execute();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("records a failed login against an unknown customer_id with a null user_id", async () => {
    const unknownCustomerId = randomUUID().replace(/-/g, "").slice(0, 8);
    await app.inject({ method: "POST", url: "/v1/auth/login", payload: { customer_id: unknownCustomerId, password: "whatever" } });

    const rows = await db
      .selectFrom("audit_log")
      .select(["action", "user_id", "resource_id"])
      .where("action", "=", "login.failure")
      .where("resource_id", "=", unknownCustomerId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBeNull();
  });

  it("records a wrong-password login failure against the resolved user_id", async () => {
    const alice = await createTestCustomer(app, { password: "audit-test-pw-2" });
    await app.inject({ method: "POST", url: "/v1/auth/login", payload: { customer_id: alice.customerId, password: "definitely-wrong" } });

    const rows = await db
      .selectFrom("audit_log")
      .select(["action", "user_id"])
      .where("user_id", "=", alice.userId)
      .where("action", "=", "login.failure")
      .execute();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("records logout", async () => {
    const alice = await createTestCustomer(app, { password: "audit-test-pw-3" });
    await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: authHeader(alice),
      payload: { refresh_token: alice.refreshToken },
    });

    const rows = await db
      .selectFrom("audit_log")
      .select(["action", "user_id"])
      .where("user_id", "=", alice.userId)
      .where("action", "=", "logout")
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("records beneficiary create and delete", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 1_000n }), createTestCustomer(app)]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Bob", rib: bob.rib },
    });
    const beneficiaryId = created.json().id;

    await app.inject({ method: "DELETE", url: `/v1/beneficiaries/${beneficiaryId}`, headers: authHeader(alice) });

    const rows = await db
      .selectFrom("audit_log")
      .select(["action", "resource_id"])
      .where("user_id", "=", alice.userId)
      .where("resource_id", "=", beneficiaryId)
      .orderBy("id")
      .execute();
    expect(rows.map((r) => r.action)).toEqual(["beneficiary.create", "beneficiary.delete"]);
  });

  it("records a settled transfer", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 5_000n }), createTestCustomer(app)]);
    const txUuid = randomUUID();

    await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: txUuid, to_rib: bob.rib, amount: "100", currency: "MAD", reference: "audit test" },
    });

    const rows = await db
      .selectFrom("audit_log")
      .select(["action", "user_id"])
      .where("resource_id", "=", txUuid)
      .where("action", "=", "transfer.settle")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(alice.userId);
  });
});

afterAll(async () => {
  await db.destroy();
});
