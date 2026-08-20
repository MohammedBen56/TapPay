import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { config } from "../../config.js";
import { db } from "../../db/kysely.js";
import { authHeader, createTestCustomer, unassignedValidRib } from "./v2TestHelpers.js";

describe("POST /transfers", () => {
  const app = buildApp({ rateLimit: false });

  it("settles a transfer to a RIB with a reference, fetchable via GET /transfers/:txUuid by both parties", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    const txUuid = randomUUID();

    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
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
      app.inject({ method: "GET", url: `/v1/transfers/${txUuid}`, headers: authHeader(alice) }),
      app.inject({ method: "GET", url: `/v1/transfers/${txUuid}`, headers: authHeader(bob) }),
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
      url: "/v1/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Bob", rib: bob.rib },
    });
    const beneficiaryId = addBeneficiary.json().id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
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
      url: "/v1/beneficiaries",
      headers: authHeader(alice),
      payload: { display_name: "Bob", rib: bob.rib },
    });
    const beneficiaryId = addBeneficiary.json().id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
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
      url: "/v1/transfers",
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
      url: "/v1/transfers",
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
      url: "/v1/transfers",
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
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "100", currency: "MAD", reference: "   " },
    });
    expect(response.statusCode).toBe(400);
  });

  it("idempotent resubmission of the same tx_uuid settles once, does not double-debit", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    const payload = { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "1000", currency: "MAD", reference: "test" };

    const first = await app.inject({ method: "POST", url: "/v1/transfers", headers: authHeader(alice), payload });
    const second = await app.inject({ method: "POST", url: "/v1/transfers", headers: authHeader(alice), payload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const balance = await app.inject({ method: "GET", url: "/v1/accounts/me/balance", headers: authHeader(alice) });
    expect(balance.json().available_balance).toBe("9000");
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      payload: { tx_uuid: randomUUID(), to_rib: unassignedValidRib(), amount: "100", currency: "MAD", reference: "test" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /transfers -- step-up + velocity cap (Ship List v2 Wave 2 Phase 4)", () => {
  const app = buildApp({ rateLimit: false });
  const bigAmount = config.stepUpThresholdMinorUnits.toString();

  async function stepUp(session: Awaited<ReturnType<typeof createTestCustomer>>, txUuid: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/step-up",
      headers: authHeader(session),
      payload: { password: session.password, tx_uuid: txUuid },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { step_up_token: string }).step_up_token;
  }

  it("rejects an at-threshold transfer with no step_up_token", async () => {
    const [alice, bob] = await Promise.all([
      createTestCustomer(app, { startingBalance: config.dailyVelocityCapMinorUnits * 10n }),
      createTestCustomer(app),
    ]);
    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: bigAmount, currency: "MAD", reference: "no step-up" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "StepUpRequired" });
  });

  it("rejects a step-up token whose password re-verification actually failed (wrong password never mints a usable token)", async () => {
    const [alice, bob] = await Promise.all([
      createTestCustomer(app, { startingBalance: config.dailyVelocityCapMinorUnits * 10n }),
      createTestCustomer(app),
    ]);
    const badStepUp = await app.inject({
      method: "POST",
      url: "/v1/auth/step-up",
      headers: authHeader(alice),
      payload: { password: "definitely-wrong", tx_uuid: randomUUID() },
    });
    expect(badStepUp.statusCode).toBe(401);

    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: {
        tx_uuid: randomUUID(),
        to_rib: bob.rib,
        amount: bigAmount,
        currency: "MAD",
        reference: "no real token",
        step_up_token: "not-a-real-token",
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("settles an at-threshold transfer given a real step_up_token from POST /auth/step-up, bound to that same tx_uuid", async () => {
    const [alice, bob] = await Promise.all([
      createTestCustomer(app, { startingBalance: config.dailyVelocityCapMinorUnits * 10n }),
      createTestCustomer(app),
    ]);
    const txUuid = randomUUID();
    const stepUpToken = await stepUp(alice, txUuid);

    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: txUuid, to_rib: bob.rib, amount: bigAmount, currency: "MAD", reference: "step-up ok", step_up_token: stepUpToken },
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects a step-up token minted for a DIFFERENT tx_uuid -- a single password re-entry cannot be replayed across separate large transfers", async () => {
    const [alice, bob] = await Promise.all([
      createTestCustomer(app, { startingBalance: config.dailyVelocityCapMinorUnits * 10n }),
      createTestCustomer(app),
    ]);
    const stepUpToken = await stepUp(alice, randomUUID());

    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: {
        tx_uuid: randomUUID(),
        to_rib: bob.rib,
        amount: bigAmount,
        currency: "MAD",
        reference: "replayed token, different tx_uuid",
        step_up_token: stepUpToken,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "StepUpRequired" });
  });

  it("a step-up token cannot authenticate an ordinary route as a bearer credential", async () => {
    const alice = await createTestCustomer(app, { startingBalance: config.dailyVelocityCapMinorUnits * 10n });
    const stepUpToken = await stepUp(alice, randomUUID());

    const response = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${stepUpToken}` } });
    expect(response.statusCode).toBe(401);
  });

  it("leaves a below-threshold transfer entirely unaffected (no step_up_token needed)", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app, { startingBalance: 10_000n }), createTestCustomer(app)]);
    const response = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "500", currency: "MAD", reference: "small, no step-up needed" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects a transfer that would push the account's rolling 24h outbound total over dailyVelocityCapMinorUnits, while a total right at the cap still settles", async () => {
    // Several sequential settlements, each paying MockBankAdapter's real
    // simulateNetwork() artificial latency (config.ts, 200-800ms) -- the
    // default 5s test timeout isn't enough headroom for this one.
    const [alice, bob] = await Promise.all([
      createTestCustomer(app, { startingBalance: config.dailyVelocityCapMinorUnits * 2n }),
      createTestCustomer(app),
    ]);
    // Stays strictly below stepUpThresholdMinorUnits throughout, so this
    // isolates the velocity cap specifically, never triggering step-up.
    const chunk = config.stepUpThresholdMinorUnits - 1n;
    const fullChunks = config.dailyVelocityCapMinorUnits / chunk;
    const remainder = config.dailyVelocityCapMinorUnits % chunk;

    for (let i = 0n; i < fullChunks; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/transfers",
        headers: authHeader(alice),
        payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: chunk.toString(), currency: "MAD", reference: `velocity chunk ${i}` },
      });
      expect(response.statusCode).toBe(200);
    }

    if (remainder > 0n) {
      const atCap = await app.inject({
        method: "POST",
        url: "/v1/transfers",
        headers: authHeader(alice),
        payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: remainder.toString(), currency: "MAD", reference: "exactly at the cap" },
      });
      expect(atCap.statusCode).toBe(200);
    }

    const overCap = await app.inject({
      method: "POST",
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "1", currency: "MAD", reference: "over the cap by 1 minor unit" },
    });
    expect(overCap.statusCode).toBe(429);
    expect(overCap.json()).toMatchObject({ error: "VelocityCapExceeded" });
  }, 30_000);

  it("does not let concurrent requests each pass the velocity check before any of them has committed -- /security-review TOCTOU finding", async () => {
    // Before the fix (withAccountAdvisoryLock in db/advisoryLock.ts), every
    // one of these N concurrent requests would read the same "before" SUM
    // and all would pass individually, letting the account's real 24h
    // total sail past dailyVelocityCapMinorUnits. With the fix, requests on
    // the same account serialize, so only as many settle as actually fit
    // under the cap -- the rest see a real 429, not a race.
    const [alice, bob] = await Promise.all([
      createTestCustomer(app, { startingBalance: config.dailyVelocityCapMinorUnits * 2n }),
      createTestCustomer(app),
    ]);
    const chunk = config.stepUpThresholdMinorUnits - 1n; // stays below step-up, isolates velocity cap
    const concurrentRequests = Number(config.dailyVelocityCapMinorUnits / chunk) + 1; // one more than fits

    const responses = await Promise.all(
      Array.from({ length: concurrentRequests }, () =>
        app.inject({
          method: "POST",
          url: "/v1/transfers",
          headers: authHeader(alice),
          payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: chunk.toString(), currency: "MAD", reference: "concurrent velocity probe" },
        }),
      ),
    );

    const settledCount = responses.filter((r) => r.statusCode === 200).length;
    // 429 covers both a real VelocityCapExceeded rejection AND AccountBusy
    // (Postgres 55P03, lock_not_available) -- withAccountAdvisoryLock's
    // blocking wait can exceed dbLockTimeoutMs when this many requests
    // queue for the same account's lock at once. Both are honest "this
    // one didn't settle" outcomes; a 500 would not be.
    const rejectedCount = responses.filter((r) => r.statusCode === 429).length;
    expect(responses.every((r) => r.statusCode === 200 || r.statusCode === 429)).toBe(true);
    expect(settledCount + rejectedCount).toBe(concurrentRequests);
    // The whole point of the fix: NOT every request can have settled --
    // concurrentRequests * chunk is deliberately over the cap.
    expect(settledCount).toBeLessThan(concurrentRequests);

    const debited = await db
      .selectFrom("journal")
      .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
      .where("account_id", "=", alice.accountId)
      .where("amount", "<", 0n)
      .executeTakeFirst();
    const totalDebited = debited?.total ? -debited.total : 0n;
    expect(totalDebited).toBeLessThanOrEqual(config.dailyVelocityCapMinorUnits);
    expect(totalDebited).toBe(BigInt(settledCount) * chunk);
  }, 30_000);
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
      url: "/v1/transfers",
      headers: authHeader(alice),
      payload: { tx_uuid: randomUUID(), to_rib: bob.rib, amount: "100", currency: "MAD", reference: "test" },
    });
    const txUuid = submit.json().tx_uuid;

    const response = await app.inject({ method: "GET", url: `/v1/transfers/${txUuid}`, headers: authHeader(mallory) });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /lookup/rib/:rib", () => {
  const app = buildApp({ rateLimit: false });

  it("resolves a valid, known RIB to its display name", async () => {
    const [alice, bob] = await Promise.all([createTestCustomer(app), createTestCustomer(app, { displayName: "Karim Bennani" })]);
    const response = await app.inject({ method: "GET", url: `/v1/lookup/rib/${bob.rib}`, headers: authHeader(alice) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rib: bob.rib, display_name: "Karim Bennani" });
  });

  it("404s identically for a syntactically valid-but-unknown RIB and a malformed one -- no enumeration signal", async () => {
    const alice = await createTestCustomer(app);
    const unknown = await app.inject({ method: "GET", url: `/v1/lookup/rib/${unassignedValidRib()}`, headers: authHeader(alice) });
    const malformed = await app.inject({ method: "GET", url: "/v1/lookup/rib/not-a-rib", headers: authHeader(alice) });
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(unknown.json()).toEqual(malformed.json());
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "GET", url: `/v1/lookup/rib/${unassignedValidRib()}` });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
