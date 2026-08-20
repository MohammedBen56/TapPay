import { randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../auth/passwords.js";
import { buildApp } from "../../app.js";
import { config } from "../../config.js";
import { db } from "../../db/kysely.js";

function randomRib(): string {
  // 24 digits, matching accounts.rib's CHECK constraint -- exact check-key
  // correctness isn't this suite's concern (see packages/shared/src/rib.ts,
  // M2), just a syntactically valid, unique value per test customer.
  let digits = "";
  for (let i = 0; i < 24; i++) digits += randomInt(0, 10).toString();
  return digits;
}

async function createTestCustomer(password: string, startingBalance = 0n) {
  const customerId = randomUUID().replace(/-/g, "").slice(0, 8);
  const userId = randomUUID();
  const accountId = randomUUID();
  const passwordHash = await hashPassword(password);

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("users")
      .values({ user_id: userId, email: `${customerId}@tappay.local`, display_name: "Test Customer" })
      .execute();
    await trx
      .insertInto("accounts")
      .values({
        account_id: accountId,
        user_id: userId,
        currency: "MAD",
        rib: randomRib(),
      })
      .execute();
    await trx
      .insertInto("customer_credentials")
      .values({ customer_id: customerId, user_id: userId, password_hash: passwordHash })
      .execute();
    if (startingBalance > 0n) {
      const txUuid = randomUUID();
      await trx
        .insertInto("journal")
        .values([
          { tx_uuid: txUuid, account_id: "00000000-0000-0000-0000-000000000000", amount: -startingBalance, currency: "MAD" },
          { tx_uuid: txUuid, account_id: accountId, amount: startingBalance, currency: "MAD" },
        ])
        .execute();
    }
  });

  return { customerId, userId, accountId };
}

describe("POST /auth/login", () => {
  const app = buildApp({ rateLimit: false });

  it("issues an access + refresh token pair for correct credentials", async () => {
    const { customerId, accountId } = await createTestCustomer("correct horse battery staple");

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { customer_id: customerId, password: "correct horse battery staple" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.access_token).toBeTypeOf("string");
    expect(body.refresh_token).toBeTypeOf("string");
    expect(body.user).toEqual({ customer_id: customerId, account_id: accountId });
  });

  it("rejects a wrong password with a generic 401, same shape as an unknown customer_id", async () => {
    const { customerId } = await createTestCustomer("the-real-password");

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { customer_id: customerId, password: "not-the-password" },
    });
    const unknownCustomer = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { customer_id: "no-such-customer", password: "anything" },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownCustomer.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownCustomer.json());
  });

  it("locks the account after the configured number of failed attempts, even with the correct password", async () => {
    const { customerId } = await createTestCustomer("the-real-password");

    for (let i = 0; i < config.loginMaxFailedAttempts; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { customer_id: customerId, password: "wrong" },
      });
      expect(res.statusCode).toBe(401);
    }

    const lockedOut = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { customer_id: customerId, password: "the-real-password" },
    });
    expect(lockedOut.statusCode).toBe(401);
  });

  it("resets the failure counter on a successful login", async () => {
    const { customerId } = await createTestCustomer("the-real-password");

    await app.inject({ method: "POST", url: "/auth/login", payload: { customer_id: customerId, password: "wrong" } });
    const success = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { customer_id: customerId, password: "the-real-password" },
    });
    expect(success.statusCode).toBe(200);

    const row = await db
      .selectFrom("customer_credentials")
      .select(["failed_attempts", "locked_until"])
      .where("customer_id", "=", customerId)
      .executeTakeFirstOrThrow();
    expect(row.failed_attempts).toBe(0);
    expect(row.locked_until).toBeNull();
  });
});

describe("POST /auth/refresh", () => {
  const app = buildApp({ rateLimit: false });

  it("rotates a valid refresh token and issues a new pair", async () => {
    const { customerId } = await createTestCustomer("pw");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { customer_id: customerId, password: "pw" } });
    const { refresh_token } = login.json();

    const refreshed = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token } });

    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refresh_token).not.toBe(refresh_token);
    expect(refreshed.json().access_token).toBeTypeOf("string");
  });

  it("rejects reuse of an already-rotated token", async () => {
    const { customerId } = await createTestCustomer("pw");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { customer_id: customerId, password: "pw" } });
    const { refresh_token } = login.json();

    await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token } });
    const reuse = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token } });

    expect(reuse.statusCode).toBe(401);
  });

  it("reuse of a rotated token revokes the whole family -- the second-generation token stops working too", async () => {
    const { customerId } = await createTestCustomer("pw");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { customer_id: customerId, password: "pw" } });
    const { refresh_token: gen1 } = login.json();

    const firstRefresh = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: gen1 } });
    const { refresh_token: gen2 } = firstRefresh.json();

    // Replay the already-superseded gen1 token -- theft-detection path.
    await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: gen1 } });

    // gen2, the legitimate next-in-chain token, must now be dead too.
    const usingGen2 = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: gen2 } });
    expect(usingGen2.statusCode).toBe(401);
  });

  it("rejects an unrecognized token", async () => {
    const response = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token: "not-a-real-token" } });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  const app = buildApp({ rateLimit: false });

  it("revokes the refresh token so it can no longer be used to refresh", async () => {
    const { customerId } = await createTestCustomer("pw");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { customer_id: customerId, password: "pw" } });
    const { access_token, refresh_token } = login.json();

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: `Bearer ${access_token}` },
      payload: { refresh_token },
    });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token } });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("requires a valid access token", async () => {
    const response = await app.inject({ method: "POST", url: "/auth/logout", payload: { refresh_token: "irrelevant" } });
    expect(response.statusCode).toBe(401);
  });
});

afterAll(async () => {
  await db.destroy();
});
