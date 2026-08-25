import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

describe("financial goals (goals.ts, Ship List v2 Wave 2 Phase 5)", () => {
  const app = buildApp({ rateLimit: false });

  // Ship List v2 Wave 3 (self-review hardening pass): funding a goal now
  // checks the real savings balance (goals.ts's own header comment has the
  // full reasoning) -- opens savings and moves real money into it via an
  // ordinary internal transfer, matching accounts.test.ts's own pattern,
  // rather than letting a goal earmark money that was never there.
  async function openAndFundSavings(
    session: Awaited<ReturnType<typeof createTestCustomer>>,
    amountMinor: string,
  ): Promise<{ account_id: string; rib: string }> {
    const openRes = await app.inject({ method: "POST", url: "/v1/accounts", headers: authHeader(session), payload: { account_type: "savings" } });
    const savings = openRes.json() as { account_id: string; rib: string };
    const fundRes = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(session),
      payload: { tx_uuid: randomUUID(), to_rib: savings.rib, amount: amountMinor, currency: "MAD", reference: "to savings" },
    });
    expect(fundRes.statusCode).toBe(200);
    return savings;
  }

  it("creates, lists, funds, and deletes a goal, scoped to the caller", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 100_000n });
    await openAndFundSavings(alice, "50000");

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

    // Funding a GOAL (as opposed to funding savings itself, above) is pure
    // bookkeeping -- no journal rows, no money movement. Snapshot the
    // journal count right before the goal-fund call, since the savings
    // top-up above legitimately did write journal rows of its own.
    const journalCountBefore = await db.selectFrom("journal").select((eb) => eb.fn.countAll().as("count")).executeTakeFirstOrThrow();

    const fund = await app.inject({
      method: "POST",
      url: `/v1/goals/${goalId}/fund`,
      headers: authHeader(alice),
      payload: { amount: "25000" },
    });
    expect(fund.statusCode).toBe(200);
    expect(fund.json()).toMatchObject({ saved_amount: "25000" });

    const journalCountAfter = await db.selectFrom("journal").select((eb) => eb.fn.countAll().as("count")).executeTakeFirstOrThrow();
    expect(journalCountAfter.count).toBe(journalCountBefore.count);

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

  it("rejects funding a goal with no savings account open yet", async () => {
    const alice = await createTestCustomer(app);
    const create = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: authHeader(alice),
      payload: { name: "No savings yet", target_amount: "100000" },
    });
    const goalId = create.json().id as string;

    const fund = await app.inject({
      method: "POST",
      url: `/v1/goals/${goalId}/fund`,
      headers: authHeader(alice),
      payload: { amount: "1" },
    });
    expect(fund.statusCode).toBe(404);
    expect(fund.json()).toMatchObject({ error: "NoSavingsAccount" });
  });

  it("rejects funding a goal (or several) past the real savings balance -- no earmarking money that isn't there", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 100_000n });
    await openAndFundSavings(alice, "10000");

    const create = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: authHeader(alice),
      payload: { name: "Bigger than savings", target_amount: "100000" },
    });
    const goalId = create.json().id as string;

    const overfund = await app.inject({
      method: "POST",
      url: `/v1/goals/${goalId}/fund`,
      headers: authHeader(alice),
      payload: { amount: "10001" },
    });
    expect(overfund.statusCode).toBe(400);
    expect(overfund.json()).toMatchObject({ error: "InsufficientSavings" });

    // Funding exactly up to the real balance succeeds...
    const exact = await app.inject({
      method: "POST",
      url: `/v1/goals/${goalId}/fund`,
      headers: authHeader(alice),
      payload: { amount: "10000" },
    });
    expect(exact.statusCode).toBe(200);

    // ...and a SECOND goal can no longer be funded at all, since the first
    // goal already earmarked the entire real savings balance.
    const secondGoal = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: authHeader(alice),
      payload: { name: "Second goal", target_amount: "100000" },
    });
    const secondFund = await app.inject({
      method: "POST",
      url: `/v1/goals/${secondGoal.json().id}/fund`,
      headers: authHeader(alice),
      payload: { amount: "1" },
    });
    expect(secondFund.statusCode).toBe(400);
    expect(secondFund.json()).toMatchObject({ error: "InsufficientSavings" });
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/goals" });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
