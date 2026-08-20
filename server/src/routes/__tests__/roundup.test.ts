import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

/** Ship List v2 Wave 2 Phase 5: opt-in round-up savings. */
describe("round-up savings (roundup.ts, wired into POST /transfers and POST /bill-payments)", () => {
  const app = buildApp({ rateLimit: false });

  async function openSavingsAndEnableRoundUp(session: Awaited<ReturnType<typeof createTestCustomer>>): Promise<string> {
    const openSavings = await app.inject({ method: "POST", url: "/v1/accounts", headers: authHeader(session), payload: { account_type: "savings" } });
    expect(openSavings.statusCode).toBe(201);
    const enable = await app.inject({ method: "PATCH", url: "/v1/me", headers: authHeader(session), payload: { round_up_enabled: true } });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({ round_up_enabled: true });
    return (openSavings.json() as { account_id: string }).account_id;
  }

  it("sweeps the round-up difference to savings after a non-round transfer, when enabled", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 100_000n }), createTestCustomer(app)]);
    const savingsAccountId = await openSavingsAndEnableRoundUp(alice);

    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "1743", currency: "MAD", reference: "roundup test" },
    });
    expect(response.statusCode).toBe(200);

    const savingsBalance = await db
      .selectFrom("journal")
      .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
      .where("account_id", "=", savingsAccountId)
      .executeTakeFirst();
    // 1743 rounds up to 1800 -- a 57 minor-unit sweep.
    expect(savingsBalance?.total).toBe(57n);
  });

  it("sweeps nothing when the debited amount is already a round number", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 100_000n }), createTestCustomer(app)]);
    const savingsAccountId = await openSavingsAndEnableRoundUp(alice);

    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "1800", currency: "MAD", reference: "already round" },
    });
    expect(response.statusCode).toBe(200);

    const savingsBalance = await db
      .selectFrom("journal")
      .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
      .where("account_id", "=", savingsAccountId)
      .executeTakeFirst();
    expect(savingsBalance?.total ?? 0n).toBe(0n);
  });

  it("sweeps nothing when round-up is not enabled (the default)", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 100_000n }), createTestCustomer(app)]);
    const openSavings = await app.inject({ method: "POST", url: "/v1/accounts", headers: authHeader(alice), payload: { account_type: "savings" } });
    const savingsAccountId = (openSavings.json() as { account_id: string }).account_id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "1743", currency: "MAD", reference: "no round-up" },
    });
    expect(response.statusCode).toBe(200);

    const savingsBalance = await db
      .selectFrom("journal")
      .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
      .where("account_id", "=", savingsAccountId)
      .executeTakeFirst();
    expect(savingsBalance?.total ?? 0n).toBe(0n);
  });

  it("sweeps nothing when round-up is enabled but no savings account exists yet", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 100_000n }), createTestCustomer(app)]);
    const enable = await app.inject({ method: "PATCH", url: "/v1/me", headers: authHeader(alice), payload: { round_up_enabled: true } });
    expect(enable.statusCode).toBe(200);

    // No POST /accounts call -- alice has checking only.
    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "1743", currency: "MAD", reference: "no savings yet" },
    });
    // The transfer itself must still succeed -- a round-up sweep is
    // best-effort and must never put the original settlement at risk.
    expect(response.statusCode).toBe(200);
  });

  it("resubmitting the same tx_uuid does not double-sweep", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 100_000n }), createTestCustomer(app)]);
    const savingsAccountId = await openSavingsAndEnableRoundUp(alice);
    const txUuid = randomUUID();
    const payload = { tx_uuid: txUuid, to_rib: bob.rib, amount: "1743", currency: "MAD", reference: "resubmitted" };

    const first = await app.inject({ method: "POST", url: "/v1/transfers", headers: authHeader(alice), payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/v1/transfers", headers: authHeader(alice), payload });
    expect(second.statusCode).toBe(200);

    const savingsBalance = await db
      .selectFrom("journal")
      .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
      .where("account_id", "=", savingsAccountId)
      .executeTakeFirst();
    expect(savingsBalance?.total).toBe(57n);
  });
});

afterAll(async () => {
  await db.destroy();
});
