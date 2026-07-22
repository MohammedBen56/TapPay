import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { MockBankAdapter, type ReceiptSigner } from "../adapters/MockBankAdapter.js";
import { db, MINT_ACCOUNT_ID } from "../db/kysely.js";
import { sweepExpiredReservations } from "../sweeper.js";

const stubSigner: ReceiptSigner = async () => new Uint8Array([1, 2, 3]);

async function createFundedAccount(startingBalance: bigint): Promise<string> {
  const accountId = randomUUID();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("accounts")
      .values({ account_id: accountId, user_id: randomUUID(), email: `test-${randomUUID()}@tappay.local`, currency: "MAD" })
      .execute();
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

const PAST = new Date(Date.now() - 60_000);

describe("sweepExpiredReservations", () => {
  it("releases an expired HELD reservation", async () => {
    const account = await createFundedAccount(0n);
    const txUuid = randomUUID();
    await db
      .insertInto("reservations")
      .values({ tx_uuid: txUuid, account_id: account, amount: 100n, currency: "MAD", expires_at: PAST, state: "HELD" })
      .execute();

    await sweepExpiredReservations(db);

    const row = await db.selectFrom("reservations").select("state").where("tx_uuid", "=", txUuid).executeTakeFirstOrThrow();
    expect(row.state).toBe("RELEASED");
  });

  it("never touches a COMMITTED row, even if its expires_at is in the past", async () => {
    const account = await createFundedAccount(0n);
    const txUuid = randomUUID();
    await db
      .insertInto("reservations")
      .values({
        tx_uuid: txUuid,
        account_id: account,
        amount: 100n,
        currency: "MAD",
        expires_at: PAST,
        state: "COMMITTED",
        settled_at: new Date(),
      })
      .execute();

    await sweepExpiredReservations(db);

    const row = await db.selectFrom("reservations").select("state").where("tx_uuid", "=", txUuid).executeTakeFirstOrThrow();
    expect(row.state).toBe("COMMITTED");
  });

  it("racing sweep vs commit on the same expired reservation: exactly one wins, never both or neither", async () => {
    const adapter = new MockBankAdapter(db, stubSigner, { latencyMinMs: 0, latencyMaxMs: 0 });
    const [from, to] = await Promise.all([createFundedAccount(10_000n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    await db
      .insertInto("reservations")
      .values({
        tx_uuid: txUuid,
        account_id: from,
        counterparty_account_id: to,
        amount: 1_000n,
        currency: "MAD",
        expires_at: PAST, // already expired when both race for it
        state: "HELD",
      })
      .execute();

    const [commitResult] = await Promise.all([adapter.commit(txUuid), sweepExpiredReservations(db)]);

    const row = await db.selectFrom("reservations").selectAll().where("tx_uuid", "=", txUuid).executeTakeFirstOrThrow();
    const journalRows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();

    if (row.state === "COMMITTED") {
      expect(commitResult.success).toBe(true);
      expect(journalRows).toHaveLength(2);
      expect(journalRows.reduce((sum, r) => sum + r.amount, 0n)).toBe(0n);
    } else {
      expect(row.state).toBe("RELEASED");
      expect(commitResult.success).toBe(false);
      expect(journalRows).toHaveLength(0);
    }
  });
});

afterAll(async () => {
  await db.destroy();
});
