import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

async function anyBillerByCategory(category: "electricity" | "water" | "internet") {
  return db
    .selectFrom("billers")
    .select(["id", "name", "category", "account_id"])
    .where("category", "=", category)
    .where("is_active", "=", true)
    .executeTakeFirstOrThrow();
}

describe("GET /accounts", () => {
  const app = buildApp({ rateLimit: false });

  it("lists the caller's checking account by default", async () => {
    const session = await createTestCustomer(app, { startingBalance: 5_000n });
    const response = await app.inject({ method: "GET", url: "/v1/accounts", headers: authHeader(session) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      account_id: session.accountId,
      account_type: "checking",
      rib: session.rib,
      available_balance: "5000",
    });
  });

  it("lists both accounts once savings is opened", async () => {
    const session = await createTestCustomer(app);
    await app.inject({ method: "POST", url: "/v1/accounts", headers: authHeader(session), payload: { account_type: "savings" } });

    const response = await app.inject({ method: "GET", url: "/v1/accounts", headers: authHeader(session) });
    const body = response.json();
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts.map((a: { account_type: string }) => a.account_type).sort()).toEqual(["checking", "savings"]);
  });

  it("never includes another customer's accounts", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app)]);
    await app.inject({ method: "POST", url: "/v1/accounts", headers: authHeader(bob), payload: { account_type: "savings" } });

    const response = await app.inject({ method: "GET", url: "/v1/accounts", headers: authHeader(alice) });
    expect(response.json().accounts).toHaveLength(1);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/accounts" });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /accounts", () => {
  const app = buildApp({ rateLimit: false });

  it("opens a savings account with a fresh, distinct RIB", async () => {
    const session = await createTestCustomer(app);
    const response = await app.inject({ method: "POST", url: "/v1/accounts", headers: authHeader(session), payload: { account_type: "savings" } });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ account_type: "savings", currency: "MAD", available_balance: "0" });
    expect(body.account_id).not.toBe(session.accountId);
    expect(body.rib).not.toBe(session.rib);
  });

  it("rejects opening a second savings account for the same customer", async () => {
    const session = await createTestCustomer(app);
    await app.inject({ method: "POST", url: "/v1/accounts", headers: authHeader(session), payload: { account_type: "savings" } });
    const second = await app.inject({ method: "POST", url: "/v1/accounts", headers: authHeader(session), payload: { account_type: "savings" } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "DuplicateAccount" });
  });

  it("rejects a client attempting to open a checking account", async () => {
    const session = await createTestCustomer(app);
    const response = await app.inject({ method: "POST", url: "/v1/accounts", headers: authHeader(session), payload: { account_type: "checking" } });
    expect(response.statusCode).toBe(400);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/accounts", payload: { account_type: "savings" } });
    expect(response.statusCode).toBe(401);
  });
});

describe("Account-selectable routes (Ship List v2 Phase 8)", () => {
  const app = buildApp({ rateLimit: false });

  async function openSavings(session: Awaited<ReturnType<typeof createTestCustomer>>): Promise<{ account_id: string; rib: string }> {
    const res = await app.inject({ method: "POST", url: "/v1/accounts", headers: authHeader(session), payload: { account_type: "savings" } });
    return res.json();
  }

  it("GET /me defaults to checking, and resolves an explicit account_id owned by the caller", async () => {
    const session = await createTestCustomer(app);
    const savings = await openSavings(session);

    const defaultRes = await app.inject({ method: "GET", url: "/v1/me", headers: authHeader(session) });
    expect(defaultRes.json()).toMatchObject({ account_id: session.accountId, account_type: "checking" });

    const savingsRes = await app.inject({ method: "GET", url: `/v1/me?account_id=${savings.account_id}`, headers: authHeader(session) });
    expect(savingsRes.json()).toMatchObject({ account_id: savings.account_id, account_type: "savings" });
  });

  it("GET /me 404s on another customer's account_id -- no existence leak", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app)]);
    const response = await app.inject({ method: "GET", url: `/v1/me?account_id=${bob.accountId}`, headers: authHeader(alice) });
    expect(response.statusCode).toBe(404);
  });

  it("GET /accounts/me/balance resolves the requested account", async () => {
    const session = await createTestCustomer(app, { startingBalance: 1_000n });
    const savings = await openSavings(session);

    const checkingBalance = await app.inject({ method: "GET", url: "/v1/accounts/me/balance", headers: authHeader(session) });
    expect(checkingBalance.json()).toMatchObject({ account_id: session.accountId, available_balance: "1000" });

    const savingsBalance = await app.inject({
      method: "GET",
      url: `/v1/accounts/me/balance?account_id=${savings.account_id}`,
      headers: authHeader(session),
    });
    expect(savingsBalance.json()).toMatchObject({ account_id: savings.account_id, available_balance: "0" });
  });

  it("POST /transfers with from_account_id moves money out of savings, checking->savings internal transfer settles both ways", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const savings = await openSavings(alice);

    // checking -> own savings, via RIB (an ordinary transfer under the hood).
    const internalTxUuid = randomUUID();
    const internal = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: internalTxUuid, to_rib: savings.rib, amount: "2000", currency: "MAD", reference: "to savings" },
    });
    expect(internal.statusCode).toBe(200);

    const afterInternal = await Promise.all([
      app.inject({ method: "GET", url: "/v1/accounts/me/balance", headers: authHeader(alice) }),
      app.inject({ method: "GET", url: `/v1/accounts/me/balance?account_id=${savings.account_id}`, headers: authHeader(alice) }),
    ]);
    expect(afterInternal[0].json().available_balance).toBe("8000");
    expect(afterInternal[1].json().available_balance).toBe("2000");

    // Now send FROM savings to a third party.
    const bob = await createTestCustomer(app);
    const outTxUuid = randomUUID();
    const out = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: {
        tx_uuid: outTxUuid,
        to_rib: bob.rib,
        amount: "500",
        currency: "MAD",
        reference: "from savings",
        from_account_id: savings.account_id,
      },
    });
    expect(out.statusCode).toBe(200);

    const finalSavings = await app.inject({
      method: "GET",
      url: `/v1/accounts/me/balance?account_id=${savings.account_id}`,
      headers: authHeader(alice),
    });
    expect(finalSavings.json().available_balance).toBe("1500");
  });

  it("still rejects a true self-payment to the SAME account, even with from_account_id set", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 1_000n });
    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: {
        tx_uuid: randomUUID(),
        to_rib: alice.rib,
        amount: "100",
        currency: "MAD",
        reference: "nope",
        from_account_id: alice.accountId,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "SelfPayment" });
  });

  it("GET /transfers/:txUuid finds a receipt regardless of which of the caller's own accounts was involved", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const savings = await openSavings(alice);
    const bob = await createTestCustomer(app);

    // Fund savings first (checking -> savings), same internal-transfer path
    // the earlier test in this suite already exercises.
    await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: savings.rib, amount: "1000", currency: "MAD", reference: "fund savings" },
    });

    const txUuid = randomUUID();
    const settle = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: txUuid, to_rib: bob.rib, amount: "300", currency: "MAD", reference: "from savings", from_account_id: savings.account_id },
    });
    expect(settle.statusCode, settle.body).toBe(200);

    const receipt = await app.inject({ method: "GET", url: `/v1/transfers/${txUuid}`, headers: authHeader(alice) });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({ direction: "debit", amount: "300" });
  });

  it("regression: the JWT's aid claim always resolves to checking, never non-deterministically to savings, after login and after refresh", async () => {
    // Found by /security-review: customer_credentials -> accounts joins in
    // POST /auth/login and POST /auth/refresh had no account_type filter,
    // so once a second accounts row (savings) could exist, `aid` could bind
    // to whichever row Postgres returned first -- a real correctness bug
    // (not itself a cross-user IDOR) that would silently misdirect any
    // route still keyed off `aid` directly (billPayments.ts, deliberately
    // not updated for Phase 8's account selection).
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    await openSavings(alice);

    // A fresh /auth/refresh, issued AFTER savings exists -- exactly the
    // window the bug lived in.
    const refreshed = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refresh_token: alice.refreshToken } });
    expect(refreshed.statusCode).toBe(200);
    const freshToken = refreshed.json().access_token as string;

    const biller = await anyBillerByCategory("electricity");
    const payment = await app.inject({
      method: "POST",
      url: "/v1/bill-payments",
      headers: { authorization: `Bearer ${freshToken}` },
      payload: { tx_uuid: randomUUID(), biller_id: biller.id, subscriber_reference: "ACC-1", amount: "500", currency: "MAD" },
    });
    expect(payment.statusCode, payment.body).toBe(200);

    const checkingBalance = await app.inject({
      method: "GET",
      url: "/v1/accounts/me/balance",
      headers: { authorization: `Bearer ${freshToken}` },
    });
    expect(checkingBalance.json().available_balance).toBe("9500"); // 10_000 - 500, debited from checking
  });

  it("rejects a beneficiary that resolves to the caller's OWN savings account", async () => {
    const alice = await createTestCustomer(app);
    const savings = await openSavings(alice);
    const response = await app.inject({
      method: "POST",
      url: "/v1/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Myself", rib: savings.rib },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "SelfPayment" });
  });
});

afterAll(async () => {
  await db.destroy();
});
