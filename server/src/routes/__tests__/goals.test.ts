import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

describe("financial goals (goals.ts, Ship List v2 Wave 2 Phase 5)", () => {
  const app = buildApp({ rateLimit: false });

  it("creates, lists, funds, and deletes a goal, scoped to the caller", async () => {
    const alice = await createTestCustomer(app);

    const create = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: authHeader(alice),
      payload: { name: "Trip to Fes", target_amount: "500000", target_date: "2027-06-01" },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ name: "Trip to Fes", target_amount: "500000", saved_amount: "0", target_date: "2027-06-01" });
    const goalId = create.json().id as string;

    const list = await app.inject({ method: "GET", url: "/v1/goals", headers: authHeader(alice) });
    expect(list.statusCode).toBe(200);
    expect(list.json().goals).toHaveLength(1);

    const fund = await app.inject({
      method: "POST",
      url: `/v1/goals/${goalId}/fund`,
      headers: authHeader(alice),
      payload: { amount: "25000" },
    });
    expect(fund.statusCode).toBe(200);
    expect(fund.json()).toMatchObject({ saved_amount: "25000" });

    // Funding is pure bookkeeping -- no journal rows, no money movement.
    const journalRows = await db.selectFrom("journal").select(["tx_uuid"]).where("account_id", "=", alice.accountId).execute();
    expect(journalRows).toHaveLength(0);

    const del = await app.inject({ method: "DELETE", url: `/v1/goals/${goalId}`, headers: authHeader(alice) });
    expect(del.statusCode).toBe(204);

    const listAfterDelete = await app.inject({ method: "GET", url: "/v1/goals", headers: authHeader(alice) });
    expect(listAfterDelete.json().goals).toHaveLength(0);
  });

  it("rejects a non-positive target_amount", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: authHeader(alice),
      payload: { name: "Bad goal", target_amount: "0" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("cross-customer isolation: another customer can neither fund nor delete your goal", async () => {
    const [alice, mallory] = await Promise.all([createTestCustomer(app), createTestCustomer(app)]);
    const create = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: authHeader(alice),
      payload: { name: "Alice's goal", target_amount: "100000" },
    });
    const goalId = create.json().id as string;

    const fund = await app.inject({
      method: "POST",
      url: `/v1/goals/${goalId}/fund`,
      headers: authHeader(mallory),
      payload: { amount: "1" },
    });
    expect(fund.statusCode).toBe(404);

    const del = await app.inject({ method: "DELETE", url: `/v1/goals/${goalId}`, headers: authHeader(mallory) });
    expect(del.statusCode).toBe(404);

    // Alice's goal is untouched.
    const list = await app.inject({ method: "GET", url: "/v1/goals", headers: authHeader(alice) });
    expect(list.json().goals[0]).toMatchObject({ saved_amount: "0" });
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/goals" });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
