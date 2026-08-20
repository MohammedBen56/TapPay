import { randomInt, randomUUID } from "node:crypto";
import { buildRib } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../../auth/passwords.js";
import { db, MINT_ACCOUNT_ID } from "../../db/kysely.js";

export interface TestCustomerSession {
  customerId: string;
  userId: string;
  accountId: string;
  rib: string;
  accessToken: string;
  refreshToken: string;
  /** Plaintext, test-only -- lets a test call POST /auth/step-up (Ship
   * List v2 Wave 2 Phase 4), which re-verifies the real password. Never
   * exists outside this test helper; the real app never has this. */
  password: string;
}

function randomBranchAndAccount(): { branch: string; account: string } {
  const branch = randomInt(0, 999).toString().padStart(3, "0");
  let account = "";
  for (let i = 0; i < 16; i++) account += randomInt(0, 10).toString();
  return { branch, account };
}

/** Provisions a customer directly (mirroring what server/scripts/seed.ts,
 * M1f, does for real) and logs in through the real /auth/login route, so
 * every v2 route test exercises genuine Bearer auth rather than a
 * bypassed/seeded session. */
export async function createTestCustomer(
  app: FastifyInstance,
  opts: { displayName?: string; password?: string; startingBalance?: bigint } = {},
): Promise<TestCustomerSession> {
  const customerId = randomUUID().replace(/-/g, "").slice(0, 8);
  const userId = randomUUID();
  const accountId = randomUUID();
  const password = opts.password ?? "test-password-123";
  const displayName = opts.displayName ?? "Test Customer";
  const { branch, account } = randomBranchAndAccount();
  const rib = buildRib(branch, account);
  const passwordHash = await hashPassword(password);

  await db.transaction().execute(async (trx) => {
    await trx.insertInto("users").values({ user_id: userId, email: `${customerId}@tappay.local`, display_name: displayName }).execute();
    await trx
      .insertInto("accounts")
      .values({
        account_id: accountId,
        user_id: userId,
        currency: "MAD",
        rib,
      })
      .execute();
    await trx
      .insertInto("customer_credentials")
      .values({ customer_id: customerId, user_id: userId, password_hash: passwordHash })
      .execute();
    if (opts.startingBalance && opts.startingBalance > 0n) {
      const txUuid = randomUUID();
      await trx
        .insertInto("journal")
        .values([
          { tx_uuid: txUuid, account_id: MINT_ACCOUNT_ID, amount: -opts.startingBalance, currency: "MAD" },
          { tx_uuid: txUuid, account_id: accountId, amount: opts.startingBalance, currency: "MAD" },
        ])
        .execute();
    }
  });

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { customer_id: customerId, password } });
  const { access_token, refresh_token } = login.json() as { access_token: string; refresh_token: string };

  return { customerId, userId, accountId, rib, accessToken: access_token, refreshToken: refresh_token, password };
}

export function authHeader(session: TestCustomerSession): { authorization: string } {
  return { authorization: `Bearer ${session.accessToken}` };
}

/** A syntactically valid RIB (passes isValidRib, so it exercises the
 * DB-lookup-miss path specifically) that was never provisioned to any test
 * customer -- for "valid but unknown recipient" test cases. */
export function unassignedValidRib(): string {
  const { branch, account } = randomBranchAndAccount();
  return buildRib(branch, account);
}
