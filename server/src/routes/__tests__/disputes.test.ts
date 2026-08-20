import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

describe("transaction disputes (Ship List v2 Wave 2 Phase 6)", () => {
  const app = buildApp({ rateLimit: false });

  it("files a dispute against the caller's own settled transaction", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    const settle = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "500", currency: "MAD", reference: "test" },
    });
    const txUuid = settle.json().tx_uuid as string;

    const dispute = await app.inject({
      method: "POST",
      url: "/v1/disputes",
      headers: authHeader(alice),
      payload: { tx_uuid: txUuid, reason: "I don't recognize this" },
    });
    expect(dispute.statusCode).toBe(201);
    expect(dispute.json()).toMatchObject({ tx_uuid: txUuid, status: "open" });

    // The receiving party can dispute their own side of the same
    // settlement too -- it's a distinct row (unique on user_id + tx_uuid,
    // not tx_uuid alone).
    const bobDispute = await app.inject({
      method: "POST",
      url: "/v1/disputes",
      headers: authHeader(bob),
      payload: { tx_uuid: txUuid, reason: "unexpected credit" },
    });
    expect(bobDispute.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/v1/disputes", headers: authHeader(alice) });
    expect(list.json().disputes).toHaveLength(1);
  });

  it("404s for a tx_uuid the caller's account did not participate in", async () => {
    const [alice, bob, mallory] = await Promise.all([
      createTestCustomer(app, { startingBalance: 10_000n }),
      createTestCustomer(app),
      createTestCustomer(app),
    ]);
    const settle = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "500", currency: "MAD", reference: "test" },
    });
    const txUuid = settle.json().tx_uuid as string;

    const response = await app.inject({
      method: "POST",
      url: "/v1/disputes",
      headers: authHeader(mallory),
      payload: { tx_uuid: txUuid, reason: "not mine to flag" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for a well-formed but nonexistent tx_uuid", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/disputes",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), reason: "test" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a duplicate dispute on the same transaction by the same caller", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    const settle = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "500", currency: "MAD", reference: "test" },
    });
    const txUuid = settle.json().tx_uuid as string;

    await app.inject({ method: "POST", url: "/v1/disputes", headers: authHeader(alice), payload: { tx_uuid: txUuid, reason: "first" } });
    const second = await app.inject({
      method: "POST",
      url: "/v1/disputes",
      headers: authHeader(alice),
      payload: { tx_uuid: txUuid, reason: "second" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "DuplicateDispute" });
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/disputes" });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
