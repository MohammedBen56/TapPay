import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { creditInterest } from "../interest.js";
import { db, MINT_ACCOUNT_ID } from "../db/kysely.js";
import { checkLedgerInvariants } from "../ledger/invariants.js";

async function createFundedUserAndAccount(accountType: "checking" | "savings", startingBalance: bigint): Promise<string> {
  const userId = randomUUID();
  const accountId = randomUUID();
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("users").values({ user_id: userId, email: `test-${randomUUID()}@tappay.local` }).execute();
    await trx.insertInto("accounts").values({ account_id: accountId, user_id: userId, currency: "MAD", account_type: accountType }).execute();
    if (startingBalance > 0n) {
      const txUuid = randomUUID();
      await trx
        .insertInto("journal")
        .values([
          { tx_uuid: txUuid, account_id: MINT_ACCOUNT_ID, amount: -startingBalance, currency: "MAD" },
          { tx_uuid: txUuid, account_id: accountId, amount: startingBalance, currency: "MAD" },
        ])
        .execute();
    }
  });
  return accountId;
}

async function balanceOf(accountId: string): Promise<bigint> {
  const row = await db
    .selectFrom("journal")
    .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row?.total ?? 0n;
}

// Assertions below check only each test's OWN account balances -- never a
// global mint-balance delta, which would be flaky under vitest's default
// parallel-test-file execution (other files' savings accounts sharing this
// same real Postgres database also get credited by any creditInterest()
// call running concurrently). Per-account balances are unaffected by that:
// each is a sum over only its own journal rows.
describe("creditInterest", () => {
  it("credits a savings account at the configured rate, funded from the mint account", async () => {
    const savings = await createFundedUserAndAccount("savings", 1_000_000n); // 10,000.00 MAD
    // 1 basis point (0.01%) of 1,000,000 = 100.
    const credited = await creditInterest(db, 1);
    expect(credited).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(savings)).toBe(1_000_100n);
  });

  it("never touches a checking account", async () => {
    const checking = await createFundedUserAndAccount("checking", 1_000_000n);
    await creditInterest(db, 1);
    expect(await balanceOf(checking)).toBe(1_000_000n);
  });

  it("skips a zero-balance savings account (no interest on nothing owed)", async () => {
    const savings = await createFundedUserAndAccount("savings", 0n);
    await creditInterest(db, 1);
    expect(await balanceOf(savings)).toBe(0n);
  });

  it("each of several savings accounts is credited independently and correctly", async () => {
    const [a, b] = await Promise.all([createFundedUserAndAccount("savings", 500_000n), createFundedUserAndAccount("savings", 750_000n)]);
    await creditInterest(db, 2); // 2bp = 0.02%
    expect(await balanceOf(a)).toBe(500_100n); // 500_000 + 500_000*2/10_000
    expect(await balanceOf(b)).toBe(750_150n); // 750_000 + 750_000*2/10_000
  });

  it("leaves the whole ledger's sum-to-zero invariant intact after a credit pass", async () => {
    await createFundedUserAndAccount("savings", 300_000n);
    await creditInterest(db, 1);
    const report = await checkLedgerInvariants(db);
    expect(report.ok).toBe(true);
    expect(report.globalImbalance).toBe(0n);
  });
});

afterAll(async () => {
  await db.destroy();
});
