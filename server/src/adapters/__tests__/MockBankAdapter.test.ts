import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db, MINT_ACCOUNT_ID } from "../../db/kysely.js";
import { MockBankAdapter, type ReceiptSigner } from "../MockBankAdapter.js";

// Deliberately non-deterministic: proves idempotent resubmission returns
// byte-identical receipts because they're STORED and reused, not because this
// stub signer happens to be stable across calls.
const randomSigner: ReceiptSigner = async () => crypto.getRandomValues(new Uint8Array(8));

async function createFundedAccount(startingBalance: bigint): Promise<string> {
  const accountId = randomUUID();
  const userId = randomUUID();
  const email = `test-${randomUUID()}@tappay.local`;
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("accounts").values({ account_id: accountId, user_id: userId, email, currency: "MAD" }).execute();
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

async function journalSum(txUuid: string): Promise<bigint> {
  const rows = await db.selectFrom("journal").select("amount").where("tx_uuid", "=", txUuid).execute();
  return rows.reduce((sum, r) => sum + r.amount, 0n);
}

async function balanceOf(accountId: string): Promise<bigint> {
  const row = await db
    .selectFrom("journal")
    .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row?.total ?? 0n;
}

describe("MockBankAdapter", () => {
  const adapter = new MockBankAdapter(db, randomSigner, { latencyMinMs: 0, latencyMaxMs: 0 });

  it("transfer() writes a sum-to-zero journal pair and moves the balance", async () => {
    const [a, b] = await Promise.all([createFundedAccount(10_000n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    const result = await adapter.transfer(txUuid, a, b, 2_500n, "MAD");

    expect(result.success).toBe(true);
    expect(await journalSum(txUuid)).toBe(0n);
    expect(await balanceOf(a)).toBe(7_500n);
    expect(await balanceOf(b)).toBe(2_500n);
  });

  it("insufficient funds fails closed with no journal write", async () => {
    const [a, b] = await Promise.all([createFundedAccount(100n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    const result = await adapter.transfer(txUuid, a, b, 1_000n, "MAD");

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("insufficient_funds");
    const rows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(rows).toHaveLength(0);
  });

  it("idempotent resubmission returns the exact same receipt with no double-journaling", async () => {
    const [a, b] = await Promise.all([createFundedAccount(10_000n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    const first = await adapter.transfer(txUuid, a, b, 1_000n, "MAD");
    const second = await adapter.transfer(txUuid, a, b, 1_000n, "MAD");

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.receiptSignature).toEqual(first.receiptSignature);

    const rows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(rows).toHaveLength(2); // one debit, one credit -- not four
    expect(await balanceOf(a)).toBe(9_000n); // debited once, not twice
  });

  // ADV-06. Pinned to exactly two accounts, both directions, concurrently: lock
  // ordering only matters when two concurrent transactions grab the *same pair* of
  // accounts in opposite directions. A larger pool would rarely collide and the
  // test would pass without ever exercising the ordering it's meant to prove.
  it(
    "ADV-06: 100 concurrent bidirectional transfers between the same two accounts deadlock-free",
    async () => {
      const [a, b] = await Promise.all([createFundedAccount(1_000_000n), createFundedAccount(1_000_000n)]);

      const transfers = Array.from({ length: 100 }, (_, i) => {
        const forward = i % 2 === 0;
        return { txUuid: randomUUID(), from: forward ? a : b, to: forward ? b : a, amount: 100n };
      });

      const WORKER_COUNT = 10;
      const batches: (typeof transfers)[] = Array.from({ length: WORKER_COUNT }, () => []);
      transfers.forEach((t, i) => batches[i % WORKER_COUNT]!.push(t));

      const results = await Promise.all(
        batches.map(async (batch) => {
          const out = [];
          for (const t of batch) {
            out.push(await adapter.transfer(t.txUuid, t.from, t.to, t.amount, "MAD"));
          }
          return out;
        }),
      );

      const flat = results.flat();
      expect(flat.every((r) => r.success)).toBe(true);

      // 50 forward + 50 reverse at equal amounts nets to zero movement.
      expect(await balanceOf(a)).toBe(1_000_000n);
      expect(await balanceOf(b)).toBe(1_000_000n);
    },
    30_000,
  );
});

afterAll(async () => {
  await db.destroy();
});
