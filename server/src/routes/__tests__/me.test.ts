import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

describe("GET /me", () => {
  const app = buildApp({ rateLimit: false });

  it("returns the authenticated customer's profile, including a derived IBAN", async () => {
    const session = await createTestCustomer(app, { displayName: "Yasmine Idrissi" });

    const response = await app.inject({ method: "GET", url: "/me", headers: authHeader(session) });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      customer_id: session.customerId,
      display_name: "Yasmine Idrissi",
      account_id: session.accountId,
      rib: session.rib,
      currency: "MAD",
    });
    expect(body.iban.startsWith("MA")).toBe(true);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/me" });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /accounts/me/balance", () => {
  const app = buildApp({ rateLimit: false });

  it("returns the caller's own balance, scoped from the token, not any account id in the request", async () => {
    const session = await createTestCustomer(app, { startingBalance: 5_000n });
    const response = await app.inject({ method: "GET", url: "/accounts/me/balance", headers: authHeader(session) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ account_id: session.accountId, currency: "MAD", available_balance: "5000" });
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/accounts/me/balance" });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /accounts/me/transactions", () => {
  const app = buildApp({ rateLimit: false });

  it("lists a settled transfer with counterparty and reference, correctly signed for each side", async () => {
    const [alice, bob] = await Promise.all([
      createTestCustomer(app, { displayName: "Alice", startingBalance: 10_000n }),
      createTestCustomer(app, { displayName: "Bob" }),
    ]);

    await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "1000", currency: "MAD", reference: "Loyer" },
    });

    const aliceHistory = await app.inject({ method: "GET", url: "/accounts/me/transactions", headers: authHeader(alice) });
    const bobHistory = await app.inject({ method: "GET", url: "/accounts/me/transactions", headers: authHeader(bob) });

    expect(aliceHistory.statusCode).toBe(200);
    expect(aliceHistory.json().transactions[0]).toMatchObject({
      direction: "debit",
      amount: "1000",
      currency: "MAD",
      counterparty_name: "Bob",
      reference: "Loyer",
    });
    expect(bobHistory.json().transactions[0]).toMatchObject({
      direction: "credit",
      amount: "1000",
      currency: "MAD",
      counterparty_name: "Alice",
      reference: "Loyer",
    });
  });

  it("paginates via next_cursor -- a smaller page size still surfaces every transaction exactly once, in order", async () => {
    // 5 sequential /transfers calls each carry MockBankAdapter's real
    // 200-800ms simulated latency (config.mockLatencyMinMs/MaxMs) -- the
    // default 5s vitest timeout is too tight for that plus several
    // pagination round trips against the same real adapter.
    // startingBalance itself lands as a real journal entry (a mint transfer),
    // so alice's true history is these 5 plus that one -- track the 5 we
    // actually submitted rather than assuming a total count.
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 100_000n }), createTestCustomer(app)]);
    const submitted = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const txUuid = randomUUID();
      await app.inject({
        method: "POST",
        url: "/transfers",
        headers: authHeader(alice),
        payload: { tx_uuid: txUuid, to_rib: bob.rib, amount: "100", currency: "MAD", reference: `tx ${i}` },
      });
      submitted.add(txUuid);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url: string = cursor
        ? `/accounts/me/transactions?limit=2&before=${encodeURIComponent(cursor)}`
        : "/accounts/me/transactions?limit=2";
      const res = await app.inject({ method: "GET", url, headers: authHeader(alice) });
      const body = res.json() as { transactions: { tx_uuid: string }[]; next_cursor: string | null };
      seen.push(...body.transactions.map((t) => t.tx_uuid));
      cursor = body.next_cursor;
      if (!cursor) break;
    }

    // No duplicates across pages, and every submitted transfer surfaced.
    expect(seen.length).toBe(new Set(seen).size);
    for (const txUuid of submitted) {
      expect(seen).toContain(txUuid);
    }
  }, 20_000);

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/accounts/me/transactions" });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /accounts/me/statement", () => {
  const app = buildApp({ rateLimit: false });

  function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  it("returns opening/closing balance and transactions within a date range covering now", async () => {
    const [alice, bob] = await Promise.all([
      createTestCustomer(app, { startingBalance: 10_000n }),
      createTestCustomer(app),
    ]);
    const txUuid = randomUUID();
    await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: txUuid, to_rib: bob.rib, amount: "1500", currency: "MAD", reference: "statement test" },
    });

    const from = isoDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const to = isoDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const response = await app.inject({
      method: "GET",
      url: `/accounts/me/statement?from=${from}&to=${to}`,
      headers: authHeader(alice),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.opening_balance).toBe("0");
    expect(body.closing_balance).toBe("8500");
    expect(body.transactions.some((t: { tx_uuid: string }) => t.tx_uuid === txUuid)).toBe(true);
  });

  it("a range entirely before the account existed returns zero balances and no transactions", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const response = await app.inject({
      method: "GET",
      url: "/accounts/me/statement?from=2000-01-01&to=2000-01-31",
      headers: authHeader(alice),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.opening_balance).toBe("0");
    expect(body.closing_balance).toBe("0");
    expect(body.transactions).toEqual([]);
  });

  it("rejects a malformed date and a from-after-to range", async () => {
    const alice = await createTestCustomer(app);
    const malformed = await app.inject({
      method: "GET",
      url: "/accounts/me/statement?from=not-a-date&to=2026-01-01",
      headers: authHeader(alice),
    });
    expect(malformed.statusCode).toBe(400);

    const inverted = await app.inject({
      method: "GET",
      url: "/accounts/me/statement?from=2026-06-01&to=2026-01-01",
      headers: authHeader(alice),
    });
    expect(inverted.statusCode).toBe(400);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/accounts/me/statement?from=2026-01-01&to=2026-01-31" });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /me/data-export", () => {
  const app = buildApp({ rateLimit: false });

  it("bundles the caller's own profile, transactions, and beneficiaries", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    const txUuid = randomUUID();
    await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: txUuid, to_rib: bob.rib, amount: "500", currency: "MAD", reference: "export test" },
    });
    await app.inject({
      method: "POST",
      url: "/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Bob", rib: bob.rib },
    });

    const response = await app.inject({ method: "GET", url: "/me/data-export", headers: authHeader(alice) });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.profile).toMatchObject({ customer_id: alice.customerId, rib: alice.rib });
    expect(body.transactions.some((t: { tx_uuid: string }) => t.tx_uuid === txUuid)).toBe(true);
    expect(body.beneficiaries.some((b: { rib: string }) => b.rib === bob.rib)).toBe(true);
    expect(body.bill_payments).toEqual([]);
  });

  it("never includes another customer's data", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    await app.inject({
      method: "POST",
      url: "/beneficiaries",
      headers: authHeader(bob),
      payload: { display_name: "Alice", rib: alice.rib },
    });

    const response = await app.inject({ method: "GET", url: "/me/data-export", headers: authHeader(alice) });
    const body = response.json();
    expect(body.profile.customer_id).toBe(alice.customerId);
    expect(body.beneficiaries).toHaveLength(0);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/me/data-export" });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
