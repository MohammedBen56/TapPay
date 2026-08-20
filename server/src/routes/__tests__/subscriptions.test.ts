import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { db } from "../../db/kysely.js";
import { type DebitRow, groupIntoSubscriptions } from "../subscriptions.js";
import { authHeader, createTestCustomer } from "./v2TestHelpers.js";

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function row(overrides: Partial<DebitRow>): DebitRow {
  return {
    amount: -1000n,
    currency: "MAD",
    created_at: daysAgo(0),
    counterparty_account_id: "netflix-acct",
    counterparty_name: "Netflix",
    ...overrides,
  };
}

/** Ship List v2 Wave 2 Phase 5: subscription tracking -- unit tests
 * against groupIntoSubscriptions() directly, with fabricated timestamps
 * (the app's DB role can't backdate real journal rows to exercise
 * multi-month history -- see the function's own doc comment). */
describe("groupIntoSubscriptions (pure detection logic)", () => {
  it("flags a same-counterparty, same-amount pair recurring ~30 days apart", () => {
    const rows: DebitRow[] = [row({ created_at: daysAgo(60) }), row({ created_at: daysAgo(30) }), row({ created_at: daysAgo(0) })];
    const detected = groupIntoSubscriptions(rows);
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      counterparty_name: "Netflix",
      amount: "1000",
      currency: "MAD",
      occurrences: 3,
      average_interval_days: 30,
    });
  });

  it("does not flag a single occurrence", () => {
    const detected = groupIntoSubscriptions([row({ created_at: daysAgo(0) })]);
    expect(detected).toHaveLength(0);
  });

  it("does not flag two occurrences a week apart (not roughly monthly)", () => {
    const rows: DebitRow[] = [row({ created_at: daysAgo(7) }), row({ created_at: daysAgo(0) })];
    expect(groupIntoSubscriptions(rows)).toHaveLength(0);
  });

  it("does not flag two occurrences 90 days apart (not roughly monthly)", () => {
    const rows: DebitRow[] = [row({ created_at: daysAgo(90) }), row({ created_at: daysAgo(0) })];
    expect(groupIntoSubscriptions(rows)).toHaveLength(0);
  });

  it("treats a price change as a different subscription (amount is part of the grouping key)", () => {
    const rows: DebitRow[] = [
      row({ created_at: daysAgo(60), amount: -1000n }),
      row({ created_at: daysAgo(30), amount: -1200n }), // price went up
      row({ created_at: daysAgo(0), amount: -1200n }),
    ];
    const detected = groupIntoSubscriptions(rows);
    // The old-price occurrence never recurs (only 1), the new price
    // recurs exactly twice at a monthly gap.
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ amount: "1200", occurrences: 2 });
  });

  it("keeps two different counterparties at the same amount as separate subscriptions", () => {
    const rows: DebitRow[] = [
      row({ created_at: daysAgo(60), counterparty_account_id: "netflix-acct", counterparty_name: "Netflix" }),
      row({ created_at: daysAgo(30), counterparty_account_id: "netflix-acct", counterparty_name: "Netflix" }),
      row({ created_at: daysAgo(60), counterparty_account_id: "spotify-acct", counterparty_name: "Spotify" }),
      row({ created_at: daysAgo(30), counterparty_account_id: "spotify-acct", counterparty_name: "Spotify" }),
    ];
    const detected = groupIntoSubscriptions(rows);
    expect(detected).toHaveLength(2);
    expect(detected.map((d) => d.counterparty_name).sort()).toEqual(["Netflix", "Spotify"]);
  });
});

describe("GET /subscriptions (route + real DB wiring)", () => {
  const app = buildApp({ rateLimit: false });

  it("returns an empty list for an account with no recurring pattern", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "500", currency: "MAD", reference: "one-off" },
    });

    const response = await app.inject({ method: "GET", url: "/v1/subscriptions", headers: authHeader(alice) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ subscriptions: [] });
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/subscriptions" });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
