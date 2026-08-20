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

  it("transfer() with a reference in the TransferContext persists a matching transfers row in the same transaction", async () => {
    const [a, b] = await Promise.all([createFundedAccount(10_000n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    const result = await adapter.transfer(txUuid, a, b, 1_500n, "MAD", { reference: "Loyer Septembre" });

    expect(result.success).toBe(true);
    const row = await db.selectFrom("transfers").selectAll().where("tx_uuid", "=", txUuid).executeTakeFirst();
    expect(row).toMatchObject({
      tx_uuid: txUuid,
      from_account_id: a,
      to_account_id: b,
      amount: 1_500n,
      currency: "MAD",
      reference: "Loyer Septembre",
    });
  });

  it("transfer() with no reference in the TransferContext creates no transfers row -- the parked P2P path never supplies one", async () => {
    const [a, b] = await Promise.all([createFundedAccount(10_000n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    const result = await adapter.transfer(txUuid, a, b, 500n, "MAD");

    expect(result.success).toBe(true);
    const row = await db.selectFrom("transfers").selectAll().where("tx_uuid", "=", txUuid).executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it("idempotent resubmission does not touch the transfers row a second time", async () => {
    const [a, b] = await Promise.all([createFundedAccount(10_000n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    await adapter.transfer(txUuid, a, b, 750n, "MAD", { reference: "first reference" });
    // Same tx_uuid, same parties/amount/currency (required or it's a
    // conflict, not a resubmission) -- a differing reference on a replay
    // must not overwrite the original, since reference is fixed at first
    // settlement (see MockBankAdapter.transfer()'s own comment).
    await adapter.transfer(txUuid, a, b, 750n, "MAD", { reference: "a different reference" });

    const rows = await db.selectFrom("transfers").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reference).toBe("first reference");
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

  it("a different transfer reusing a COMMITTED tx_uuid is rejected, not resumed", async () => {
    const [a, b] = await Promise.all([createFundedAccount(10_000n), createFundedAccount(0n)]);
    const [c, d] = await Promise.all([createFundedAccount(10_000n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    const original = await adapter.transfer(txUuid, a, b, 1_000n, "MAD");
    expect(original.success).toBe(true);

    const hijack = await adapter.transfer(txUuid, c, d, 1_000n, "MAD");

    expect(hijack.success).toBe(false);
    expect(hijack.failureReason).toBe("tx_uuid_conflict");
    // The hijacker must not receive the original parties' receipt bytes.
    expect(hijack.receiptSignature).not.toEqual(original.receiptSignature);
    const rows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(rows).toHaveLength(2); // still just the original pair
    expect(await balanceOf(c)).toBe(10_000n); // hijacker's own balance untouched
    expect(await balanceOf(d)).toBe(0n);
  });

  it("a different transfer reusing a COMMITTED tx_uuid with the same parties but a different amount is rejected", async () => {
    const [a, b] = await Promise.all([createFundedAccount(10_000n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    await adapter.transfer(txUuid, a, b, 1_000n, "MAD");
    const result = await adapter.transfer(txUuid, a, b, 2_000n, "MAD");

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("tx_uuid_conflict");
    expect(await balanceOf(a)).toBe(9_000n); // only the original 1,000 moved
  });

  it("a different transfer reusing a COMMITTED tx_uuid with a different currency is rejected", async () => {
    const [a, b] = await Promise.all([createFundedAccount(10_000n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    await adapter.transfer(txUuid, a, b, 1_000n, "MAD");
    const result = await adapter.transfer(txUuid, a, b, 1_000n, "USD");

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("tx_uuid_conflict");
  });

  it("a pre-existing HELD reservation for a tx_uuid blocks transfer() from commandeering it", async () => {
    // A bare reserve() (no counterparty) for this tx_uuid, from an unrelated
    // flow. Before the guard, transfer() calling the same tx_uuid would skip
    // the balance check entirely (the `if (!existing)` branch that normally
    // gates it) and journal ITS OWN accounts/amount against this row.
    const holder = await createFundedAccount(100n);
    const [c, d] = await Promise.all([createFundedAccount(10n), createFundedAccount(0n)]);
    const txUuid = randomUUID();

    const held = await adapter.reserve(txUuid, holder, 50n, "MAD", 30);
    expect(held.success).toBe(true);

    const result = await adapter.transfer(txUuid, c, d, 5_000_000n, "MAD");

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("tx_uuid_conflict");
    const rows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(rows).toHaveLength(0); // the balance check was never bypassed
  });

  // reserve()/release()/commit() are each exercised only indirectly via
  // transfer() above -- transfer() always creates a HELD row WITH a
  // counterparty and commits it in the same call, so it never touches
  // reserve()'s standalone idempotency/expiry branches, release(), or
  // commit()'s own no-counterparty/not-found/RELEASED branches. Covered
  // directly here.
  describe("reserve() standalone", () => {
    it("creates a HELD reservation without moving any balance", async () => {
      const a = await createFundedAccount(1_000n);
      const txUuid = randomUUID();

      const result = await adapter.reserve(txUuid, a, 400n, "MAD", 30);

      expect(result.success).toBe(true);
      expect(result.reservationId).toBe(txUuid);
      expect(await balanceOf(a)).toBe(1_000n); // reserve() never journals
      const row = await db.selectFrom("reservations").selectAll().where("tx_uuid", "=", txUuid).executeTakeFirstOrThrow();
      expect(row.state).toBe("HELD");
      expect(row.counterparty_account_id).toBeNull();
    });

    it("fails closed on insufficient funds, no reservation row created", async () => {
      const a = await createFundedAccount(10n);
      const txUuid = randomUUID();

      const result = await adapter.reserve(txUuid, a, 1_000n, "MAD", 30);

      expect(result.success).toBe(false);
      expect(result.failureReason).toBe("insufficient_funds");
      const row = await db.selectFrom("reservations").selectAll().where("tx_uuid", "=", txUuid).executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it("resubmitting the same tx_uuid while still HELD is idempotent, not a second balance check", async () => {
      const a = await createFundedAccount(1_000n);
      const txUuid = randomUUID();

      const first = await adapter.reserve(txUuid, a, 900n, "MAD", 30);
      // A second HELD reservation for a different tx_uuid would fail here
      // (only 100 left available) -- proves the resubmission below really is
      // hitting the idempotent-return branch, not re-running the balance check.
      const second = await adapter.reserve(txUuid, a, 900n, "MAD", 30);

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      const rows = await db.selectFrom("reservations").selectAll().where("tx_uuid", "=", txUuid).execute();
      expect(rows).toHaveLength(1); // no duplicate row inserted
    });

    it("reusing a tx_uuid whose reservation was already RELEASED fails as reservation_expired", async () => {
      const a = await createFundedAccount(1_000n);
      const txUuid = randomUUID();
      await adapter.reserve(txUuid, a, 100n, "MAD", 30);
      await adapter.release(txUuid);

      const result = await adapter.reserve(txUuid, a, 100n, "MAD", 30);

      expect(result.success).toBe(false);
      expect(result.failureReason).toBe("reservation_expired");
    });
  });

  describe("release() standalone", () => {
    it("frees a HELD reservation's balance back to available", async () => {
      const a = await createFundedAccount(1_000n);
      const txUuid = randomUUID();
      await adapter.reserve(txUuid, a, 1_000n, "MAD", 30);

      expect(await adapter.getAvailableBalance(a, "MAD")).toBe(0n); // fully held

      await adapter.release(txUuid);

      expect(await adapter.getAvailableBalance(a, "MAD")).toBe(1_000n);
      const row = await db.selectFrom("reservations").selectAll().where("tx_uuid", "=", txUuid).executeTakeFirstOrThrow();
      expect(row.state).toBe("RELEASED");
    });

    it("is a silent no-op against an unknown tx_uuid -- release() has no failure signal by design", async () => {
      await expect(adapter.release(randomUUID())).resolves.toBeUndefined();
    });

    it("does not un-commit an already-COMMITTED reservation (state='HELD' guard on the UPDATE)", async () => {
      const [a, b] = await Promise.all([createFundedAccount(1_000n), createFundedAccount(0n)]);
      const txUuid = randomUUID();
      await adapter.transfer(txUuid, a, b, 500n, "MAD");

      await adapter.release(txUuid);

      const row = await db.selectFrom("reservations").selectAll().where("tx_uuid", "=", txUuid).executeTakeFirstOrThrow();
      expect(row.state).toBe("COMMITTED"); // untouched
      expect(await balanceOf(a)).toBe(500n); // the settled transfer still stands
    });
  });

  describe("commit() standalone", () => {
    it("fails closed as no_counterparty for a bare reserve() -- refuses to invent a settlement destination", async () => {
      const a = await createFundedAccount(1_000n);
      const txUuid = randomUUID();
      await adapter.reserve(txUuid, a, 100n, "MAD", 30);

      const result = await adapter.commit(txUuid);

      expect(result.success).toBe(false);
      expect(result.failureReason).toBe("no_counterparty");
      const rows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
      expect(rows).toHaveLength(0);
    });

    it("reservation_not_found for a tx_uuid with no reservation row at all", async () => {
      const result = await adapter.commit(randomUUID());
      expect(result.success).toBe(false);
      expect(result.failureReason).toBe("reservation_not_found");
    });

    it("reservation_expired for a RELEASED reservation", async () => {
      const a = await createFundedAccount(1_000n);
      const txUuid = randomUUID();
      await adapter.reserve(txUuid, a, 100n, "MAD", 30);
      await adapter.release(txUuid);

      const result = await adapter.commit(txUuid);

      expect(result.success).toBe(false);
      expect(result.failureReason).toBe("reservation_expired");
    });

    it("settles a HELD reservation that does have a counterparty (inserted directly -- reserve() itself never sets one; only transfer() does, and transfer() always commits in the same call)", async () => {
      const [a, b] = await Promise.all([createFundedAccount(1_000n), createFundedAccount(0n)]);
      const txUuid = randomUUID();
      await db
        .insertInto("reservations")
        .values({
          tx_uuid: txUuid,
          account_id: a,
          counterparty_account_id: b,
          amount: 300n,
          currency: "MAD",
          expires_at: new Date(Date.now() + 30_000),
          state: "HELD",
        })
        .execute();

      const result = await adapter.commit(txUuid);

      expect(result.success).toBe(true);
      expect(await journalSum(txUuid)).toBe(0n);
      expect(await balanceOf(a)).toBe(700n);
      expect(await balanceOf(b)).toBe(300n);
    });

    it("idempotent resubmission returns the exact same receipt with no double journal write", async () => {
      const [a, b] = await Promise.all([createFundedAccount(1_000n), createFundedAccount(0n)]);
      const txUuid = randomUUID();
      await db
        .insertInto("reservations")
        .values({
          tx_uuid: txUuid,
          account_id: a,
          counterparty_account_id: b,
          amount: 300n,
          currency: "MAD",
          expires_at: new Date(Date.now() + 30_000),
          state: "HELD",
        })
        .execute();

      const first = await adapter.commit(txUuid);
      const second = await adapter.commit(txUuid);

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(second.receiptSignature).toEqual(first.receiptSignature);
      const rows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
      expect(rows).toHaveLength(2); // one debit, one credit -- not four
    });
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
