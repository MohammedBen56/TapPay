import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer, unassignedValidRib } from "./v2TestHelpers.js";

describe("POST /transfers", () => {
  const app = buildApp({ rateLimit: false });

  it("settles a transfer to a RIB with a reference, fetchable via GET /transfers/:txUuid by both parties", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    const txUuid = randomUUID();

    const response = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: txUuid, to_rib: bob.rib, amount: "2500", currency: "MAD", reference: "Remboursement déjeuner" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tx_uuid: txUuid,
      amount: "2500",
      currency: "MAD",
      reference: "Remboursement déjeuner",
      counterparty: { rib: bob.rib },
      balance_after: "7500",
    });

    const [aliceView, bobView] = await Promise.all([
      app.inject({ method: "GET", url: `/transfers/${txUuid}`, headers: authHeader(alice) }),
      app.inject({ method: "GET", url: `/transfers/${txUuid}`, headers: authHeader(bob) }),
    ]);
    expect(aliceView.json()).toMatchObject({ direction: "debit", reference: "Remboursement déjeuner" });
    expect(bobView.json()).toMatchObject({ direction: "credit", reference: "Remboursement déjeuner" });
  });

  it("settles a transfer to a saved beneficiary via to_beneficiary_id", async () => {
    const [alice, bob] = await Promise.all([
      createTestCustomer(app, { startingBalance: 10_000n }),
      createTestCustomer(app, { displayName: "Bob" }),
    ]);
    const addBeneficiary = await app.inject({
      method: "POST",
      url: "/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Bob", rib: bob.rib },
    });
    const beneficiaryId = addBeneficiary.json().id;

    const response = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_beneficiary_id: beneficiaryId, amount: "500", currency: "MAD", reference: "test" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects a beneficiary id belonging to a different customer", async () => {
    const [alice, bob, mallory] = await Promise.all([
      createTestCustomer(app, { startingBalance: 10_000n }),
      createTestCustomer(app),
      createTestCustomer(app, { startingBalance: 10_000n }),
    ]);
    const addBeneficiary = await app.inject({
      method: "POST",
      url: "/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Bob", rib: bob.rib },
    });
    const beneficiaryId = addBeneficiary.json().id;

    const response = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(mallory),
      payload: { tx_uuid: randomUUID(), to_beneficiary_id: beneficiaryId, amount: "500", currency: "MAD", reference: "test" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("UnknownBeneficiary");
  });

  it("rejects a self-payment", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const response = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: alice.rib, amount: "100", currency: "MAD", reference: "test" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("SelfPayment");
  });

  it("rejects a syntactically valid but unassigned RIB with UnknownRecipient", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const response = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: unassignedValidRib(), amount: "100", currency: "MAD", reference: "test" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("UnknownRecipient");
  });

  it("rejects a syntactically invalid RIB before touching the database", async () => {
    const alice = await createTestCustomer(app, { startingBalance: 10_000n });
    const response = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: "not-a-rib", amount: "100", currency: "MAD", reference: "test" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("InvalidRib");
  });

  it("rejects an empty or whitespace-only reference", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    const response = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "100", currency: "MAD", reference: "   " },
    });
    expect(response.statusCode).toBe(400);
  });

  it("idempotent resubmission of the same tx_uuid settles once, does not double-debit", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    const payload = { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "1000", currency: "MAD", reference: "test" };

    const first = await app.inject({ method: "POST", url: "/transfers", headers: authHeader(alice), payload });
    const second = await app.inject({ method: "POST", url: "/transfers", headers: authHeader(alice), payload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const balance = await app.inject({ method: "GET", url: "/accounts/me/balance", headers: authHeader(alice) });
    expect(balance.json().available_balance).toBe("9000");
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/transfers",
      payload: { tx_uuid: randomUUID(), to_rib: unassignedValidRib(), amount: "100", currency: "MAD", reference: "test" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /transfers/:txUuid", () => {
  const app = buildApp({ rateLimit: false });

  it("404s for a tx_uuid the caller's account did not participate in", async () => {
    const [alice, bob, mallory] = await Promise.all([
      createTestCustomer(app, { startingBalance: 10_000n }),
      createTestCustomer(app),
      createTestCustomer(app),
    ]);
    const submit = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "100", currency: "MAD", reference: "test" },
    });
    const txUuid = submit.json().tx_uuid;

    const response = await app.inject({ method: "GET", url: `/transfers/${txUuid}`, headers: authHeader(mallory) });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /lookup/rib/:rib", () => {
  const app = buildApp({ rateLimit: false });

  it("resolves a valid, known RIB to its display name", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app, { displayName: "Karim Bennani" })]);
    const response = await app.inject({ method: "GET", url: `/lookup/rib/${bob.rib}`, headers: authHeader(alice) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rib: bob.rib, display_name: "Karim Bennani" });
  });

  it("404s identically for a syntactically valid-but-unknown RIB and a malformed one -- no enumeration signal", async () => {
    const alice = await createTestCustomer(app);
    const unknown = await app.inject({ method: "GET", url: `/lookup/rib/${unassignedValidRib()}`, headers: authHeader(alice) });
    const malformed = await app.inject({ method: "GET", url: "/lookup/rib/not-a-rib", headers: authHeader(alice) });
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(unknown.json()).toEqual(malformed.json());
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: `/lookup/rib/${unassignedValidRib()}` });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
