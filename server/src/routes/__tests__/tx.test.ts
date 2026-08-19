import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";

// The COSE-signed /tx/submit suite (and every test that depends on it to
// produce a settled receipt) moved to
// parked/routes/__tests__/tx-cose.test.ts alongside the rest of the parked
// P2P-proximity routes (CLAUDE.md v2 pivot). What's left here is genuinely
// generic: malformed-input handling on the two GET routes that stayed live.
describe("/tx read routes", () => {
  const app = buildApp({ rateLimit: false });

  it("GET /accounts/:accountId/balance rejects a malformed accountId with a typed 400, not a raw DB error", async () => {
    const response = await app.inject({ method: "GET", url: "/accounts/not-a-uuid/balance" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("InvalidRequest");
  });

  it("GET /tx/:txUuid/receipt rejects a malformed txUuid with a typed 400, not a raw DB error", async () => {
    const response = await app.inject({ method: "GET", url: "/tx/not-a-uuid/receipt" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("InvalidRequest");
  });
});

afterAll(async () => {
  await db.destroy();
});
