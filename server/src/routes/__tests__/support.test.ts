import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

describe("in-app support requests (Ship List v2 Wave 2 Phase 6)", () => {
  const app = buildApp({ rateLimit: false });

  it("creates and lists a support request, scoped to the caller", async () => {
    const alice = await createTestCustomer(app);

    const create = await app.inject({
      method: "POST",
      url: "/v1/support-requests",
      headers: authHeader(alice),
      payload: { subject: "Question about round-up", message: "How does the round-up amount get chosen?" },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ subject: "Question about round-up", status: "open" });

    const list = await app.inject({ method: "GET", url: "/v1/support-requests", headers: authHeader(alice) });
    expect(list.statusCode).toBe(200);
    expect(list.json().support_requests).toHaveLength(1);
  });

  it("does not leak another customer's support requests", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app)]);
    await app.inject({
      method: "POST",
      url: "/v1/support-requests",
      headers: authHeader(alice),
      payload: { subject: "Alice's question", message: "..." },
    });

    const bobList = await app.inject({ method: "GET", url: "/v1/support-requests", headers: authHeader(bob) });
    expect(bobList.json().support_requests).toHaveLength(0);
  });

  it("rejects an empty subject/message", async () => {
    const alice = await createTestCustomer(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/support-requests",
      headers: authHeader(alice),
      payload: { subject: "", message: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/support-requests" });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
