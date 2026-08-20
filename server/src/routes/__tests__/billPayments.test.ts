import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

/** Migration 018_billers.cjs seeds 6 real billers directly (not via
 * seed.ts, which CI never runs -- see that migration's own comment), so
 * every environment that has run migrations has real billers to test
 * against. Fetched by category rather than hardcoded by name/id so this
 * test file doesn't hardcode the mock catalog's exact contents. */
async function anyBillerByCategory(category: "electricity" | "water" | "internet") {
  return db
    .selectFrom("billers")
    .select(["id", "name", "category", "account_id"])
    .where("category", "=", category)
    .where("is_active", "=", true)
    .executeTakeFirstOrThrow();
}

describe("GET /billers", () => {
  const app = buildApp({ rateLimit: false });

  it("lists active billers across all categories", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({ method: "GET", url: "/v1/billers", headers: authHeader(alice) });
    expect(response.statusCode).toBe(200);
    const { billers } = response.json() as { billers: { category: string }[] };
    expect(billers.length).toBeGreaterThanOrEqual(6);
    expect(billers.some((b) => b.category === "electricity")).toBe(true);
    expect(billers.some((b) => b.category === "water")).toBe(true);
    expect(billers.some((b) => b.category === "internet")).toBe(true);
  });

  it("filters by category", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({ method: "GET", url: "/v1/billers?category=water", headers: authHeader(alice) });
    expect(response.statusCode).toBe(200);
    const { billers } = response.json() as { billers: { category: string }[] };
    expect(billers.length).toBeGreaterThan(0);
    expect(billers.every((b) => b.category === "water")).toBe(true);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/billers" });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /bill-payments", () => {
  const app = buildApp({ rateLimit: false });

  it("settles a bill payment, fetchable via GET /bill-payments/:txUuid, and shows up in the biller-flagged transaction history", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const biller = await anyBillerByCategory("electricity");
    const txUuid = randomUUID();

    const response = await app.inject({
      method: "POST",
      url: "/v1/bill-payments",
      headers: authHeader(alice),
      payload: { tx_uuid: txUuid, biller_id: biller.id, subscriber_reference: "CTR-445566", amount: "2500", currency: "MAD" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      tx_uuid: txUuid,
      biller: { id: biller.id, name: biller.name, category: "electricity" },
      subscriber_reference: "CTR-445566",
      amount: "2500",
      currency: "MAD",
      balance_after: "7500",
    });
    expect(body.reference).toContain(biller.name);
    expect(body.reference).toContain("CTR-445566");

    const detail = await app.inject({ method: "GET", url: `/v1/bill-payments/${txUuid}`, headers: authHeader(alice) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ tx_uuid: txUuid, subscriber_reference: "CTR-445566", amount: "2500" });

    // GET /transfers/:txUuid (same tx_uuid, since settlement reuses
    // bankAdapter.transfer()) flags the counterparty as a biller.
    const transferDetail = await app.inject({ method: "GET", url: `/v1/transfers/${txUuid}`, headers: authHeader(alice) });
    expect(transferDetail.statusCode).toBe(200);
    expect(transferDetail.json()).toMatchObject({ is_biller: true, biller_category: "electricity" });

    const history = await app.inject({ method: "GET", url: "/v1/accounts/me/transactions", headers: authHeader(alice) });
    const historyRow = (history.json().transactions as { tx_uuid: string }[]).find((t) => t.tx_uuid === txUuid);
    expect(historyRow).toMatchObject({ is_biller: true, biller_category: "electricity" });
  });

  it("404s for an unknown biller_id", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const response = await app.inject({
      method: "POST",
      url: "/v1/bill-payments",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), biller_id: randomUUID(), subscriber_reference: "CTR-1", amount: "100", currency: "MAD" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("UnknownBiller");
  });

  it("409s for insufficient funds", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 100n });
    const biller = await anyBillerByCategory("water");
    const response = await app.inject({
      method: "POST",
      url: "/v1/bill-payments",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), biller_id: biller.id, subscriber_reference: "CTR-2", amount: "5000", currency: "MAD" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("InsufficientFunds");
  });

  it("rejects an empty subscriber_reference", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const biller = await anyBillerByCategory("internet");
    const response = await app.inject({
      method: "POST",
      url: "/v1/bill-payments",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), biller_id: biller.id, subscriber_reference: "   ", amount: "100", currency: "MAD" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-positive amount", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const biller = await anyBillerByCategory("internet");
    const response = await app.inject({
      method: "POST",
      url: "/v1/bill-payments",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), biller_id: biller.id, subscriber_reference: "CTR-3", amount: "0", currency: "MAD" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("InvalidAmount");
  });

  it("idempotent resubmission of the same tx_uuid settles once, does not double-debit", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const biller = await anyBillerByCategory("electricity");
    const payload = { tx_uuid: randomUUID(), biller_id: biller.id, subscriber_reference: "CTR-4", amount: "1000", currency: "MAD" };

    const first = await app.inject({ method: "POST", url: "/v1/bill-payments", headers: authHeader(alice), payload });
    const second = await app.inject({ method: "POST", url: "/v1/bill-payments", headers: authHeader(alice), payload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const balance = await app.inject({ method: "GET", url: "/v1/accounts/me/balance", headers: authHeader(alice) });
    expect(balance.json().available_balance).toBe("9000");
  });

  it("requires a valid access token", async () => {
    const biller = await anyBillerByCategory("water");
    const response = await app.inject({
      method: "POST",
      url: "/v1/bill-payments",
      payload: { tx_uuid: randomUUID(), biller_id: biller.id, subscriber_reference: "CTR-5", amount: "100", currency: "MAD" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /bill-payments", () => {
  const app = buildApp({ rateLimit: false });

  it("paginates the caller's own bill payments, scoped away from other customers", async () => {
    const [alice, mallory] = await Promise.all([
      createTestCustomer(app, { startingBalance: 10_000n }),
      createTestCustomer(app, { startingBalance: 10_000n }),
    ]);
    const [electricity, water] = await Promise.all([anyBillerByCategory("electricity"), anyBillerByCategory("water")]);

    await app.inject({
      method: "POST",
      url: "/v1/bill-payments",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), biller_id: electricity.id, subscriber_reference: "A-1", amount: "100", currency: "MAD" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/bill-payments",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), biller_id: water.id, subscriber_reference: "A-2", amount: "200", currency: "MAD" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/bill-payments",
      headers: authHeader(mallory),
      payload: { tx_uuid: randomUUID(), biller_id: electricity.id, subscriber_reference: "M-1", amount: "300", currency: "MAD" },
    });

    const firstPage = await app.inject({ method: "GET", url: "/v1/bill-payments?limit=1", headers: authHeader(alice) });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json() as { bill_payments: { subscriber_reference: string }[]; next_cursor: string | null };
    expect(firstBody.bill_payments).toHaveLength(1);
    expect(firstBody.next_cursor).not.toBeNull();

    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/bill-payments?limit=1&before=${encodeURIComponent(firstBody.next_cursor!)}`,
      headers: authHeader(alice),
    });
    const secondBody = secondPage.json() as { bill_payments: { subscriber_reference: string }[] };
    expect(secondBody.bill_payments).toHaveLength(1);

    const allRefs = [...firstBody.bill_payments, ...secondBody.bill_payments].map((p) => p.subscriber_reference);
    expect(allRefs.sort()).toEqual(["A-1", "A-2"]);
  });
});

afterAll(async () => {
  await db.destroy();
});
