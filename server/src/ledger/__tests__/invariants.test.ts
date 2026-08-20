import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../../config.js";
import { createDb, db, MINT_ACCOUNT_ID } from "../../db/kysely.js";
import { checkLedgerInvariants } from "../invariants.js";

// `db` connects as the app's own restricted `tappay_app` role (migration
// 017), which can no longer UPDATE/DELETE journal or transfers -- correct
// for the app itself, but this file's own cleanup of its deliberately
// malformed rows needs the schema-owning role's privileges, the same way an
// operator fixing bad data would. Using a separate, owner-privileged
// connection for cleanup ONLY (never for the assertions themselves, which
// all still run through the real app role via `db`) keeps this test honest
// about which privilege level it's actually exercising.
const ownerDb = createDb(config.databaseUrl);
afterAll(async () => {
  await ownerDb.destroy();
});

async function createFundedAccount(startingBalance: bigint): Promise<string> {
  const accountId = randomUUID();
  const userId = randomUUID();
  const email = `test-${randomUUID()}@tappay.local`;
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("users").values({ user_id: userId, email }).execute();
    await trx.insertInto("accounts").values({ account_id: accountId, user_id: userId, currency: "MAD" }).execute();
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

describe("checkLedgerInvariants", () => {
  it("reports clean against real, correctly-settled journal rows", async () => {
    await createFundedAccount(5_000n);
    const report = await checkLedgerInvariants(db);
    expect(report.ok).toBe(true);
    expect(report.globalImbalance).toBe(0n);
    expect(report.unbalancedTransactions).toEqual([]);
    expect(report.malformedTransactions).toEqual([]);
    expect(report.negativeBalanceAccounts).toEqual([]);
    expect(report.transferJournalMismatches).toEqual([]);
  });

  // These three tests deliberately insert invariant-violating rows into the
  // real, shared test database -- checkLedgerInvariants scans the whole
  // journal/transfers tables, not just this test's own rows, and other test
  // FILES in this suite run against the same live Postgres concurrently (in
  // separate vitest worker processes). Each test cleans up its own bad rows
  // in a finally block so the shared database returns to a clean state
  // regardless of ordering, rather than relying on any isolation this
  // module's read-only queries don't provide.

  it("catches a single-leg (orphaned) journal row", async () => {
    const account = await createFundedAccount(0n);
    const txUuid = randomUUID();
    await db.insertInto("journal").values({ tx_uuid: txUuid, account_id: account, amount: 100n, currency: "MAD" }).execute();

    try {
      const report = await checkLedgerInvariants(db);
      expect(report.ok).toBe(false);
      expect(report.globalImbalance).not.toBe(0n);
      expect(report.malformedTransactions.some((m) => m.tx_uuid === txUuid && m.row_count === 1)).toBe(true);
    } finally {
      await ownerDb.deleteFrom("journal").where("tx_uuid", "=", txUuid).execute();
    }
  });

  it("catches a two-leg transaction whose postings don't sum to zero", async () => {
    const a = await createFundedAccount(0n);
    const b = await createFundedAccount(0n);
    const txUuid = randomUUID();
    // Deliberately malformed: -100 and +150, global sum stays nonzero on its
    // own, but the point of the per-tx_uuid check is catching this even in
    // scenarios where a second, opposite error would cancel it out globally.
    await db
      .insertInto("journal")
      .values([
        { tx_uuid: txUuid, account_id: a, amount: -100n, currency: "MAD" },
        { tx_uuid: txUuid, account_id: b, amount: 150n, currency: "MAD" },
      ])
      .execute();

    try {
      const report = await checkLedgerInvariants(db);
      expect(report.ok).toBe(false);
      expect(report.unbalancedTransactions.some((u) => u.tx_uuid === txUuid && u.sum === 50n)).toBe(true);
    } finally {
      await ownerDb.deleteFrom("journal").where("tx_uuid", "=", txUuid).execute();
    }
  });

  it("catches a transfers row with no matching journal pair", async () => {
    const a = await createFundedAccount(1_000n);
    const b = await createFundedAccount(0n);
    const txUuid = randomUUID();
    // A transfers row inserted without ever writing the corresponding
    // journal pair -- the exact divergence 016_transfers.cjs's own comment
    // is worried about.
    await db
      .insertInto("transfers")
      .values({ tx_uuid: txUuid, from_account_id: a, to_account_id: b, amount: 250n, currency: "MAD", reference: "test" })
      .execute();

    try {
      const report = await checkLedgerInvariants(db);
      expect(report.ok).toBe(false);
      expect(report.transferJournalMismatches.some((m) => m.tx_uuid === txUuid)).toBe(true);
    } finally {
      await ownerDb.deleteFrom("transfers").where("tx_uuid", "=", txUuid).execute();
    }
  });
});
