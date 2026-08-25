import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { config } from "../../config.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

describe("money requests (Ship List v2 Wave 2 Phase 7)", () => {
  const app = buildApp({ rateLimit: false });

  it("creates a request, shows it as incoming for the target and outgoing for the requester, then fulfills it via an ordinary settlement", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app, { startingBalance: 10_000n })]);

    const create = await app.inject({
      method: "POST",
      url: "/v1/money-requests",
      headers: authHeader(alice),
      payload: { to_rib: bob.rib, amount: "2500", currency: "MAD", reference: "Dinner split" },
    });
    expect(create.statusCode).toBe(201);
    const requestId = create.json().id as string;

    const aliceView = await app.inject({ method: "GET", url: "/v1/money-requests", headers: authHeader(alice) });
    expect(aliceView.json().outgoing).toHaveLength(1);
    expect(aliceView.json().outgoing[0]).toMatchObject({ status: "pending", amount: "2500", target: { rib: bob.rib } });
    expect(aliceView.json().incoming).toHaveLength(0);

    const bobView = await app.inject({ method: "GET", url: "/v1/money-requests", headers: authHeader(bob) });
    expect(bobView.json().incoming).toHaveLength(1);
    expect(bobView.json().incoming[0]).toMatchObject({ status: "pending", amount: "2500", requester: { rib: alice.rib } });

    const fulfill = await app.inject({ method: "POST", url: `/v1/money-requests/${requestId}/fulfill`, headers: authHeader(bob) });
    expect(fulfill.statusCode).toBe(200);
    const txUuid = fulfill.json().tx_uuid as string;

    // Fulfilling is an ordinary settlement -- fetchable via the normal
    // receipt route, by either party.
    const receipt = await app.inject({ method: "GET", url: `/v1/transfers/${txUuid}`, headers: authHeader(bob) });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({ direction: "debit", amount: "2500", reference: "Dinner split" });

    const afterFulfill = await app.inject({ method: "GET", url: "/v1/money-requests", headers: authHeader(alice) });
    expect(afterFulfill.json().outgoing[0]).toMatchObject({ status: "fulfilled", tx_uuid: txUuid });
  });

  it("rejects requesting money from yourself", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/money-requests",
      headers: authHeader(alice),
      payload: { to_rib: alice.rib, amount: "100", currency: "MAD", reference: "test" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "SelfPayment" });
  });

  it("rejects a request above the same maxTransferMinorUnits cap POST /transfers enforces", async () => {
    // Found via a self-review audit: an earlier draft only checked
    // amountMinor <= 0n, so a money request had no upper bound at all even
    // though the identical amount sent via POST /transfers would be
    // rejected. This proves the cap is now shared.
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app)]);
    const response = await app.inject({
      method: "POST",
      url: "/v1/money-requests",
      headers: authHeader(alice),
      payload: { to_rib: bob.rib, amount: String(config.maxTransferMinorUnits + 1n), currency: "MAD", reference: "too much" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "InvalidAmount" });
  });

  it("only the named target can fulfill or decline a request", async () => {
    const [alice, bob, mallory] = await Promise.all([
      createTestCustomer(app),
      createTestCustomer(app, { startingBalance: 10_000n }),
      createTestCustomer(app, { startingBalance: 10_000n }),
    ]);
    const create = await app.inject({
      method: "POST",
      url: "/v1/money-requests",
      headers: authHeader(alice),
      payload: { to_rib: bob.rib, amount: "500", currency: "MAD", reference: "test" },
    });
    const requestId = create.json().id as string;

    const mallteFulfill = await app.inject({ method: "POST", url: `/v1/money-requests/${requestId}/fulfill`, headers: authHeader(mallory) });
    expect(mallteFulfill.statusCode).toBe(404);

    const malloryDecline = await app.inject({ method: "POST", url: `/v1/money-requests/${requestId}/decline`, headers: authHeader(mallory) });
    expect(malloryDecline.statusCode).toBe(404);

    // The requester (not the target) also can't fulfill their own request.
    const requesterFulfill = await app.inject({ method: "POST", url: `/v1/money-requests/${requestId}/fulfill`, headers: authHeader(alice) });
    expect(requesterFulfill.statusCode).toBe(404);
  });

  it("declining a request marks it declined and blocks a later fulfill", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app, { startingBalance: 10_000n })]);
    const create = await app.inject({
      method: "POST",
      url: "/v1/money-requests",
      headers: authHeader(alice),
      payload: { to_rib: bob.rib, amount: "500", currency: "MAD", reference: "test" },
    });
    const requestId = create.json().id as string;

    const decline = await app.inject({ method: "POST", url: `/v1/money-requests/${requestId}/decline`, headers: authHeader(bob) });
    expect(decline.statusCode).toBe(204);

    const fulfillAfterDecline = await app.inject({ method: "POST", url: `/v1/money-requests/${requestId}/fulfill`, headers: authHeader(bob) });
    expect(fulfillAfterDecline.statusCode).toBe(409);
  });

  it("rejects fulfillment when the target has insufficient funds, leaving the request pending", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app, { startingBalance: 0n })]);
    const create = await app.inject({
      method: "POST",
      url: "/v1/money-requests",
      headers: authHeader(alice),
      payload: { to_rib: bob.rib, amount: "500", currency: "MAD", reference: "test" },
    });
    const requestId = create.json().id as string;

    const fulfill = await app.inject({ method: "POST", url: `/v1/money-requests/${requestId}/fulfill`, headers: authHeader(bob) });
    expect(fulfill.statusCode).toBe(409);
    expect(fulfill.json()).toMatchObject({ error: "InsufficientFunds" });

    const list = await app.inject({ method: "GET", url: "/v1/money-requests", headers: authHeader(bob) });
    expect(list.json().incoming[0]).toMatchObject({ status: "pending" });
  });

  it("does not let concurrent fulfill calls double-settle the same request", async () => {
    // Before the fix (withAccountAdvisoryLock in db/advisoryLock.ts,
    // wrapping the pending-check + settlement + status update as one
    // atomic step), each of these concurrent requests would read
    // status="pending" before either had committed its own status
    // update, and each settle with its OWN freshly-randomized tx_uuid --
    // bankAdapter.transfer()'s tx_uuid-keyed idempotency gives no
    // protection against that, so all of them would settle, debiting the
    // target once per concurrent call instead of once total.
    const [alice, bob] = await Promise.all([
      createTestCustomer(app),
      createTestCustomer(app, { startingBalance: 10_000n }),
    ]);
    const create = await app.inject({
      method: "POST",
      url: "/v1/money-requests",
      headers: authHeader(alice),
      payload: { to_rib: bob.rib, amount: "500", currency: "MAD", reference: "concurrent fulfill probe" },
    });
    const requestId = create.json().id as string;

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => app.inject({ method: "POST", url: `/v1/money-requests/${requestId}/fulfill`, headers: authHeader(bob) })),
    );

    const fulfilledCount = responses.filter((r) => r.statusCode === 200).length;
    // 409 covers both "already fulfilled/declined" (the race-safe outcome
    // for every loser) AND AccountBusy (55P03 lock-timeout under this
    // much contention); either is an honest "this one didn't settle."
    expect(responses.every((r) => r.statusCode === 200 || r.statusCode === 409 || r.statusCode === 429)).toBe(true);
    expect(fulfilledCount).toBe(1);

    const debited = await db
      .selectFrom("journal")
      .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
      .where("account_id", "=", bob.accountId)
      .where("amount", "<", 0n)
      .executeTakeFirst();
    // Exactly one 500-minor-unit debit, not six.
    expect(-(debited?.total ?? 0n)).toBe(500n);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/money-requests" });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
