import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { INTEREST_ADVISORY_LOCK_KEY, withAdvisoryLock } from "./db/advisoryLock.js";
import { lockAccountsInOrder } from "./db/locking.js";
import { MINT_ACCOUNT_ID, type Database } from "./db/kysely.js";

/**
 * Ship List v2 Phase 8: a mock fixed-rate interest job for savings
 * accounts, funded from the mint account -- same pattern seed.ts already
 * uses for starting balances. Each credit is an ordinary paired journal
 * transfer (not a special-cased ledger operation), so it's automatically
 * covered by every existing invariant (sum-to-zero per tx_uuid, ordered
 * row locking against a concurrent real transfer on the same account) and
 * shows up in the customer's transaction history for free.
 *
 * A zero/negative balance is skipped entirely -- no interest on nothing
 * owed, and a savings balance can never actually go negative in practice
 * (MockBankAdapter's overdraft check), but this stays defensive rather
 * than assuming that invariant from the caller's side.
 */
export async function creditInterest(db: Kysely<Database>, rateBp: number): Promise<number> {
  const savingsAccounts = await db
    .selectFrom("accounts")
    .select(["account_id", "currency"])
    .where("account_type", "=", "savings")
    .execute();

  let credited = 0;
  for (const account of savingsAccounts) {
    await db.transaction().execute(async (trx) => {
      // Same ordered-lock discipline as every real transfer (ADR-0002) --
      // lockAccountsInOrder is the one function in this codebase trusted to
      // get that ordering right, reused rather than reimplemented here.
      await lockAccountsInOrder(trx, MINT_ACCOUNT_ID, account.account_id);

      const balanceRow = await trx
        .selectFrom("journal")
        .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
        .where("account_id", "=", account.account_id)
        .where("currency", "=", account.currency)
        .executeTakeFirst();
      const balance = balanceRow?.total ?? 0n;
      if (balance <= 0n) return;

      const interest = (balance * BigInt(rateBp)) / 10_000n;
      if (interest <= 0n) return;

      const txUuid = randomUUID();
      await trx
        .insertInto("journal")
        .values([
          { tx_uuid: txUuid, account_id: MINT_ACCOUNT_ID, amount: -interest, currency: account.currency },
          { tx_uuid: txUuid, account_id: account.account_id, amount: interest, currency: account.currency },
        ])
        .execute();
      credited++;
    });
  }
  return credited;
}

export interface InterestJobLogger {
  error: (obj: unknown, msg?: string) => void;
}

export interface InterestJob {
  stop: () => Promise<void>;
}

/** Same setInterval/advisory-lock/stop shape as sweeper.ts and
 * tripwire.ts (Ship List v2 Phase 6) -- only the replica that wins the
 * tick's advisory lock actually runs the credit pass. */
export function startInterestJob(db: Kysely<Database>, intervalMs: number, rateBp: number, logger: InterestJobLogger): InterestJob {
  let inFlight: Promise<number | null> | null = null;

  const timer = setInterval(() => {
    inFlight = withAdvisoryLock(db, INTEREST_ADVISORY_LOCK_KEY, (db) => creditInterest(db, rateBp))
      .catch((err: unknown) => {
        logger.error(err, "interest job tick failed");
        return 0;
      })
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);
  timer.unref();

  return {
    stop: async () => {
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}
