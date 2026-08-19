import type { Kysely } from "kysely";
import type { CommitResult, IBankAdapter, ReservationResult, TransferContext } from "@tappay/shared";
import type { Database } from "../db/kysely.js";
import { availableBalanceLocked, lockAccount, lockAccountsInOrder } from "../db/locking.js";
import { config } from "../config.js";

export class MockBankFault extends Error {
  constructor(message = "MockBankAdapter: injected fault") {
    super(message);
    this.name = "MockBankFault";
  }
}

/** 16 zero bytes -- the receipt's recipient binding when no TransferContext is
 * available (commit()'s bare-reservation path, which has no route today) or
 * for Mode C, which has no nonce concept in OfflineIou. Not the same as "no
 * binding at all": the caller-side check still requires the receiver_nonce
 * field to equal what the payee itself generated, and Mode C payees always
 * expect all-zero, so a receipt from a context-less path can never satisfy a
 * Mode A/B payee's non-zero-nonce check. */
// Deliberately NOT typed `: TransferContext` -- both fields are optional on
// that interface (v2 added a third, `reference`), but every field here is
// always concretely defined, and signReceipt (below) needs that narrower,
// non-optional type at its two call sites.
export const ZERO_RECEIPT_CONTEXT = { recipientDeviceId: new Uint8Array(16), receiverNonce: new Uint8Array(16) };

/** Produces the server's COSE_Sign1 receipt bytes over a settled transaction.
 * Injected rather than hardcoded to a specific crypto library, so MockBankAdapter's
 * ledger-correctness tests (Step 3) don't need the real COSE signer (Step 5) to
 * exist -- Step 8 wires in the real one.
 *
 * recipientDeviceId/receiverNonce bind the receipt to its intended payee --
 * see TxReceipt's doc comment (packages/shared/src/types.ts) for why. */
export type ReceiptSigner = (params: {
  txUuid: string;
  amount: bigint;
  currency: string;
  settledAt: Date;
  recipientDeviceId: Uint8Array;
  receiverNonce: Uint8Array;
}) => Promise<Uint8Array>;

export interface MockBankAdapterOptions {
  latencyMinMs?: number;
  latencyMaxMs?: number;
  /** Fraction (0..1) of calls that throw MockBankFault after the latency delay. */
  faultInjectionRate?: number;
}

const EMPTY_RECEIPT = new Uint8Array();

export class MockBankAdapter implements IBankAdapter {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly signReceipt: ReceiptSigner,
    private readonly opts: MockBankAdapterOptions = {},
  ) {}

  private async simulateNetwork(): Promise<void> {
    const min = this.opts.latencyMinMs ?? config.mockLatencyMinMs;
    const max = this.opts.latencyMaxMs ?? config.mockLatencyMaxMs;
    const delayMs = min + Math.random() * Math.max(0, max - min);
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const faultRate = this.opts.faultInjectionRate ?? config.faultInjectionRate;
    if (faultRate > 0 && Math.random() < faultRate) {
      throw new MockBankFault();
    }
  }

  async getAvailableBalance(accountId: string, currency: string): Promise<bigint> {
    await this.simulateNetwork();
    // Intentionally unlocked -- fine for a status read, never reused as the
    // authoritative check inside reserve()/transfer() (see locking.ts).
    const journalRow = await this.db
      .selectFrom("journal")
      .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
      .where("account_id", "=", accountId)
      .where("currency", "=", currency)
      .executeTakeFirst();
    const heldRow = await this.db
      .selectFrom("reservations")
      .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
      .where("account_id", "=", accountId)
      .where("state", "=", "HELD")
      .executeTakeFirst();
    return (journalRow?.total ?? 0n) - (heldRow?.total ?? 0n);
  }

  async reserve(
    txUuid: string,
    accountId: string,
    amount: bigint,
    currency: string,
    ttlSeconds: number,
  ): Promise<ReservationResult> {
    await this.simulateNetwork();
    return this.db.transaction().execute(async (trx) => {
      await lockAccount(trx, accountId);

      const existing = await trx
        .selectFrom("reservations")
        .select(["state"])
        .where("tx_uuid", "=", txUuid)
        .executeTakeFirst();
      if (existing) {
        if (existing.state === "RELEASED") {
          return { success: false, failureReason: "reservation_expired" };
        }
        return { success: true, reservationId: txUuid }; // idempotent resubmission
      }

      const available = await availableBalanceLocked(trx, accountId, currency);
      if (available < amount) {
        return { success: false, failureReason: "insufficient_funds" };
      }

      await trx
        .insertInto("reservations")
        .values({
          tx_uuid: txUuid,
          account_id: accountId,
          amount,
          currency,
          expires_at: new Date(Date.now() + ttlSeconds * 1000),
          state: "HELD",
        })
        .execute();

      return { success: true, reservationId: txUuid };
    });
  }

  async commit(txUuid: string): Promise<CommitResult> {
    await this.simulateNetwork();

    // account_id / counterparty_account_id / amount / currency are immutable once
    // a reservation row exists, so it's safe to read them without a lock first to
    // decide which account row(s) to lock, then re-check mutable state (`state`)
    // under that lock before acting on it.
    const reservation = await this.db
      .selectFrom("reservations")
      .selectAll()
      .where("tx_uuid", "=", txUuid)
      .executeTakeFirst();

    if (!reservation) {
      return { success: false, settledAt: new Date(0), receiptSignature: EMPTY_RECEIPT, failureReason: "reservation_not_found" };
    }

    return this.db.transaction().execute(async (trx) => {
      if (reservation.counterparty_account_id) {
        await lockAccountsInOrder(trx, reservation.account_id, reservation.counterparty_account_id);
      } else {
        await lockAccount(trx, reservation.account_id);
      }

      const locked = await trx
        .selectFrom("reservations")
        .selectAll()
        .where("tx_uuid", "=", txUuid)
        .executeTakeFirstOrThrow();

      if (locked.state === "COMMITTED") {
        // Idempotent resubmission: exact same receipt bytes, no new journal write.
        return {
          success: true,
          settledAt: locked.settled_at ?? new Date(0),
          receiptSignature: locked.receipt_signature ? new Uint8Array(locked.receipt_signature) : EMPTY_RECEIPT,
        };
      }
      if (locked.state === "RELEASED") {
        return { success: false, settledAt: new Date(0), receiptSignature: EMPTY_RECEIPT, failureReason: "reservation_expired" };
      }
      if (!locked.counterparty_account_id) {
        // A bare reserve() has no resolvable settlement target. Committing it would
        // write a journal debit with nothing to balance it against, breaking
        // sum-to-zero -- fail closed rather than invent a destination.
        return { success: false, settledAt: new Date(0), receiptSignature: EMPTY_RECEIPT, failureReason: "no_counterparty" };
      }

      // Guarded, not a blind write: this UPDATE and the sweeper's
      // `UPDATE ... WHERE state='HELD'` are both atomic per row, so whichever runs
      // first wins and the other's predicate simply no longer matches -- the
      // sweeper-vs-commit race is benign without any extra coordination.
      const settledAt = new Date();
      const updated = await trx
        .updateTable("reservations")
        .set({ state: "COMMITTED", settled_at: settledAt })
        .where("tx_uuid", "=", txUuid)
        .where("state", "=", "HELD")
        .executeTakeFirst();

      if (updated.numUpdatedRows === 0n) {
        // Lost the race to the sweeper between the unlocked read above and here.
        return { success: false, settledAt: new Date(0), receiptSignature: EMPTY_RECEIPT, failureReason: "reservation_expired" };
      }

      await trx
        .insertInto("journal")
        .values([
          { tx_uuid: txUuid, account_id: locked.account_id, amount: -locked.amount, currency: locked.currency },
          { tx_uuid: txUuid, account_id: locked.counterparty_account_id, amount: locked.amount, currency: locked.currency },
        ])
        .execute();

      // commit() has no route in production (see the interface's own doc
      // comment) and no device-level context available -- always zero-bound.
      const receiptSignature = await this.signReceipt({
        txUuid,
        amount: locked.amount,
        currency: locked.currency,
        settledAt,
        recipientDeviceId: ZERO_RECEIPT_CONTEXT.recipientDeviceId,
        receiverNonce: ZERO_RECEIPT_CONTEXT.receiverNonce,
      });
      await trx
        .updateTable("reservations")
        .set({ receipt_signature: Buffer.from(receiptSignature) })
        .where("tx_uuid", "=", txUuid)
        .execute();

      return { success: true, settledAt, receiptSignature };
    });
  }

  async release(txUuid: string): Promise<void> {
    await this.simulateNetwork();
    await this.db
      .updateTable("reservations")
      .set({ state: "RELEASED" })
      .where("tx_uuid", "=", txUuid)
      .where("state", "=", "HELD")
      .execute();
  }

  async transfer(
    txUuid: string,
    fromAccountId: string,
    toAccountId: string,
    amount: bigint,
    currency: string,
    context: TransferContext = ZERO_RECEIPT_CONTEXT,
  ): Promise<CommitResult> {
    await this.simulateNetwork();

    return this.db.transaction().execute(async (trx) => {
      await lockAccountsInOrder(trx, fromAccountId, toAccountId);

      const existing = await trx
        .selectFrom("reservations")
        .selectAll()
        .where("tx_uuid", "=", txUuid)
        .executeTakeFirst();

      // tx_uuid is chosen by whoever signs, so it is NOT scoped to a device or
      // a pair of accounts -- a different signer reusing an in-flight or
      // settled tx_uuid must be rejected outright, never silently resumed.
      // Checked BEFORE the state branches below so this also closes the HELD
      // case: without it, a pre-existing HELD row for this tx_uuid (from an
      // unrelated reserve()/transfer() call) would skip the balance check
      // entirely (see the `if (!existing)` guard further down) and get
      // committed using THIS call's accounts/amount instead of its own. Same
      // bug family as the tx_uuid settlement-slot hijack already fixed once
      // in routes/sync.ts (see CLAUDE.md §5) -- this is the transfer()-level
      // instance of it, which that fix does not reach.
      if (
        existing &&
        (existing.account_id !== fromAccountId ||
          existing.counterparty_account_id !== toAccountId ||
          existing.amount !== amount ||
          existing.currency !== currency)
      ) {
        return { success: false, settledAt: new Date(0), receiptSignature: EMPTY_RECEIPT, failureReason: "tx_uuid_conflict" };
      }

      if (existing?.state === "COMMITTED") {
        // Idempotent resubmission: same receipt, no new journal write. See
        // adapters/__tests__ ADV-01-style test for the invariant this guarantees.
        return {
          success: true,
          settledAt: existing.settled_at ?? new Date(0),
          receiptSignature: existing.receipt_signature ? new Uint8Array(existing.receipt_signature) : EMPTY_RECEIPT,
        };
      }
      if (existing?.state === "RELEASED") {
        return { success: false, settledAt: new Date(0), receiptSignature: EMPTY_RECEIPT, failureReason: "reservation_expired" };
      }

      if (!existing) {
        const available = await availableBalanceLocked(trx, fromAccountId, currency);
        if (available < amount) {
          return { success: false, settledAt: new Date(0), receiptSignature: EMPTY_RECEIPT, failureReason: "insufficient_funds" };
        }
        await trx
          .insertInto("reservations")
          .values({
            tx_uuid: txUuid,
            account_id: fromAccountId,
            counterparty_account_id: toAccountId,
            amount,
            currency,
            expires_at: new Date(Date.now() + config.defaultReservationTtlSeconds * 1000),
            state: "HELD",
          })
          .execute();
      }

      const settledAt = new Date();
      const updated = await trx
        .updateTable("reservations")
        .set({ state: "COMMITTED", settled_at: settledAt })
        .where("tx_uuid", "=", txUuid)
        .where("state", "=", "HELD")
        .executeTakeFirst();

      if (updated.numUpdatedRows === 0n) {
        return { success: false, settledAt: new Date(0), receiptSignature: EMPTY_RECEIPT, failureReason: "reservation_expired" };
      }

      await trx
        .insertInto("journal")
        .values([
          { tx_uuid: txUuid, account_id: fromAccountId, amount: -amount, currency },
          { tx_uuid: txUuid, account_id: toAccountId, amount, currency },
        ])
        .execute();

      const receiptSignature = await this.signReceipt({
        txUuid,
        amount,
        currency,
        settledAt,
        recipientDeviceId: context.recipientDeviceId ?? ZERO_RECEIPT_CONTEXT.recipientDeviceId,
        receiverNonce: context.receiverNonce ?? ZERO_RECEIPT_CONTEXT.receiverNonce,
      });
      await trx
        .updateTable("reservations")
        .set({ receipt_signature: Buffer.from(receiptSignature) })
        .where("tx_uuid", "=", txUuid)
        .execute();

      // v2 (docs/TapPay_v2_Technical_Design.md §4): the human-readable
      // reference lives on its own table, keyed by tx_uuid, inserted in this
      // same transaction so a settled transfer can never exist without it.
      // onConflict...doNothing rather than erroring: this branch is also
      // reached by a fresh (non-idempotent-replay) commit of a HELD
      // reservation that was reserve()'d earlier without a reference and is
      // only now being told one via transfer()'s context -- a second call
      // for the same tx_uuid must not fail the whole settlement over a
      // cosmetic row that's already there. The COMMITTED-idempotent-replay
      // branch above returns before reaching here, so a resubmission never
      // touches this table at all -- reference is fixed at first settlement.
      if (context.reference !== undefined) {
        await trx
          .insertInto("transfers")
          .values({
            tx_uuid: txUuid,
            from_account_id: fromAccountId,
            to_account_id: toAccountId,
            amount,
            currency,
            reference: context.reference,
          })
          .onConflict((oc) => oc.column("tx_uuid").doNothing())
          .execute();
      }

      return { success: true, settledAt, receiptSignature };
    });
  }
}
