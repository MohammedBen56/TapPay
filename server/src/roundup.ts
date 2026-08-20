import { createHash } from "node:crypto";
import { bankAdapter } from "./adapters/index.js";
import { config } from "./config.js";
import { db } from "./db/kysely.js";
import { resolveAccountByType } from "./routes/accountSelection.js";

/** Derives a stable, UUID-shaped id from a seed string. NOT a spec-pure
 * RFC 4122 UUIDv5 (that requires SHA-1 over a namespace UUID + name) --
 * just a deterministic, collision-negligible identifier shaped like one,
 * so it satisfies every `z.string().uuid()` validator and Postgres UUID
 * column in this codebase. The SAME seed always derives the SAME id,
 * which is exactly what ties a round-up sweep to its triggering
 * settlement: if the ORIGINAL tx_uuid is ever resubmitted (a legitimate
 * client retry), bankAdapter.transfer() being called again with this same
 * derived tx_uuid is then a safe, idempotent no-op (CLAUDE.md §5) --
 * exactly one sweep per original settlement, never a second one on retry. */
function deriveTxUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version nibble (5 -- name-based-shaped, not a real UUIDv5)
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant bits
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Ship List v2 Wave 2 Phase 5: opt-in round-up savings. Call after a
 * successful CHECKING-account debit (POST /transfers, POST
 * /bill-payments) -- rounds the debited amount UP to the next multiple of
 * `config.roundUpToMinorUnits` and sweeps the difference into the same
 * customer's savings account via an ordinary internal transfer.
 *
 * Best-effort, matching `bill_payments`' own "second statement written
 * after settlement succeeds" posture (019_bill_payments.cjs's comment):
 * the original settlement already committed by the time this runs, so a
 * skipped/failed sweep (no savings account yet, insufficient checking
 * balance for the round-up itself, a transient DB error) never puts the
 * money that already moved at risk. Deliberately reuses
 * `bankAdapter.transfer()` rather than a raw journal insert (interest.ts's
 * shape) -- a round-up sweep is an ordinary transfer: it gets its own
 * `settlement_events` row and receipt, and shows up in both accounts'
 * history for free, exactly like a transfer the customer initiated
 * themselves.
 *
 * Caller is responsible for not letting a thrown error here fail the
 * original settlement's own response -- every call site wraps this in a
 * try/catch and logs, never lets it propagate.
 */
export async function maybeSweepRoundUp(params: {
  userId: string;
  fromAccountId: string;
  originalTxUuid: string;
  debitedAmount: bigint;
  currency: string;
}): Promise<void> {
  const { userId, fromAccountId, originalTxUuid, debitedAmount, currency } = params;

  const user = await db.selectFrom("users").select(["round_up_enabled"]).where("user_id", "=", userId).executeTakeFirst();
  if (!user?.round_up_enabled) return;

  const savings = await resolveAccountByType(userId, "savings");
  // No savings account yet, or the debit itself already came FROM savings
  // (sweeping "up" out of savings into savings makes no sense) -- skip.
  if (!savings || savings.account_id === fromAccountId) return;

  const roundTo = config.roundUpToMinorUnits;
  const remainder = debitedAmount % roundTo;
  if (remainder === 0n) return; // already a round number -- nothing to sweep
  const roundUpAmount = roundTo - remainder;

  const sweepTxUuid = deriveTxUuid(`roundup:${originalTxUuid}`);
  await bankAdapter.transfer(sweepTxUuid, fromAccountId, savings.account_id, roundUpAmount, currency, {
    reference: "Round-up savings",
  });
}
