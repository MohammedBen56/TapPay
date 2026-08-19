import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer, unassignedValidRib } from "./v2TestHelpers.js";

describe("beneficiaries CRUD", () => {
  const app = buildApp({ rateLimit: false });

  it("creates, lists, updates, and deletes a beneficiary", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app, { displayName: "Bob" })]);

    const created = await app.inject({
      method: "POST",
      url: "/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Bob", rib: bob.rib },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const listed = await app.inject({ method: "GET", url: "/beneficiaries", headers: authHeader(alice) });
    expect(listed.json().beneficiaries).toEqual([{ id, display_name: "Bob", rib: bob.rib }]);

    const updated = await app.inject({
      method: "PATCH",
      url: `/beneficiaries/${id}`,
      headers: authHeader(alice),
      payload: { display_name: "Bob (updated)" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().display_name).toBe("Bob (updated)");

    const deleted = await app.inject({ method: "DELETE", url: `/beneficiaries/${id}`, headers: authHeader(alice) });
    expect(deleted.statusCode).toBe(204);

    const listedAfter = await app.inject({ method: "GET", url: "/beneficiaries", headers: authHeader(alice) });
    expect(listedAfter.json().beneficiaries).toEqual([]);
  });

  it("rejects a duplicate RIB for the same owner", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app)]);
    const payload = { display_name: "Bob", rib: bob.rib };
    await app.inject({ method: "POST", url: "/beneficiaries", headers: authHeader(alice), payload });
    const second = await app.inject({ method: "POST", url: "/beneficiaries", headers: authHeader(alice), payload });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("DuplicateBeneficiary");
  });

  it("rejects adding oneself as a beneficiary", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({
      method: "POST",
      url: "/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Myself", rib: alice.rib },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("SelfPayment");
  });

  it("rejects a RIB with no matching account", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({
      method: "POST",
      url: "/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Ghost", rib: unassignedValidRib() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("UnknownRecipient");
  });

  it("one customer cannot read, update, or delete another customer's beneficiary -- always scoped by owner_user_id from the token", async () => {
    const [alice, bob, mallory] = await Promise.all([createTestCustomer(app), createTestCustomer(app), createTestCustomer(app)]);
    const created = await app.inject({
      method: "POST",
      url: "/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Bob", rib: bob.rib },
    });
    const id = created.json().id;

    const malloryList = await app.inject({ method: "GET", url: "/beneficiaries", headers: authHeader(mallory) });
    expect(malloryList.json().beneficiaries).toEqual([]);

    const malloryUpdate = await app.inject({
      method: "PATCH",
      url: `/beneficiaries/${id}`,
      headers: authHeader(mallory),
      payload: { display_name: "Hijacked" },
    });
    expect(malloryUpdate.statusCode).toBe(404);

    const malloryDelete = await app.inject({ method: "DELETE", url: `/beneficiaries/${id}`, headers: authHeader(mallory) });
    expect(malloryDelete.statusCode).toBe(404);

    const aliceListAfter = await app.inject({ method: "GET", url: "/beneficiaries", headers: authHeader(alice) });
    expect(aliceListAfter.json().beneficiaries).toHaveLength(1);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/beneficiaries" });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
