/**
 * fast-check as an adversarial INPUT GENERATOR only -- not fc.scheduler(),
 * which only reorders in-process Promise scheduling, not real Postgres lock
 * acquisition. The races that matter here (ADV-06's lock-ordering proof, a
 * tx_uuid hijack racing its own legitimate settlement) happen inside the
 * database, so the actual concurrency comes from real Promise.all against
 * real Postgres, reusing the ADV-06 pattern in MockBankAdapter.test.ts.
 *
 * Every generated batch runs against a FRESH pool of funded accounts (not a
 * shared/reused pool across runs), so each run's invariant check reasons
 * about a state this run alone produced. Cross-file interference from other
 * suites is ruled out structurally, not by luck: vitest.config.ts disables
 * file parallelism for exactly this reason (see its own comment) --
 * checkLedgerInvariants() below reads the WHOLE database, and this suite is
 * not the only one asserting about it (ledger/__tests__/invariants.test.ts).
 *
 * numRuns is deliberately small and the seed is fixed -- this runs on every
 * `pnpm --filter server test`, so it has to stay fast and deterministic.
 * A larger, random-seed run is a documented follow-up (see the module
 * comment at the bottom of this file), not built blind in this pass.
 */
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { db, MINT_ACCOUNT_ID } from "../../db/kysely.js";
import { checkLedgerInvariants } from "../../ledger/invariants.js";
import { MockBankAdapter, MockBankFault, type ReceiptSigner } from "../MockBankAdapter.js";

const randomSigner: ReceiptSigner = async () => crypto.getRandomValues(new Uint8Array(8));
const adapter = new MockBankAdapter(db, randomSigner, { latencyMinMs: 0, latencyMaxMs: 0 });
// A second adapter instance with fault injection forced on, used only by the
// "faulted" op kind below -- MockBankAdapter.simulateNetwork() throws
// BEFORE this.db.transaction().execute() ever starts (MockBankAdapter.ts),
// so a faulted call is a true no-op against the ledger: nothing to commit,
// nothing to roll back, invariants trivially hold. Included anyway, not
// skipped, so that guarantee is asserted by a real generated test instead
// of just being true because nobody checked.
const faultyAdapter = new MockBankAdapter(db, randomSigner, { latencyMinMs: 0, latencyMaxMs: 0, faultInjectionRate: 1 });

const POOL_SIZE = 4;
const STARTING_BALANCE = 1_000_000n;

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

// Every op group is self-contained (carries its own pre-assigned tx_uuid),
// so the generated array needs no cross-referencing between elements --
// keeps the arbitrary declarative instead of hand-rolling index plumbing.
type OpGroup =
  | {
      kind: "transfer";
      txUuid: string;
      fromIdx: number;
      toIdx: number;
      amount: bigint;
      duplicateResubmit: boolean;
      hijack: boolean;
      hijackToIdx: number;
      hijackAmount: bigint;
    }
  | { kind: "selfPayment"; txUuid: string; idx: number; amount: bigint }
  | { kind: "boundaryAmount"; txUuid: string; fromIdx: number; toIdx: number; amount: bigint }
  | { kind: "faulted"; txUuid: string; fromIdx: number; toIdx: number; amount: bigint };

const idxArb = fc.integer({ min: 0, max: POOL_SIZE - 1 });
const amountArb = fc.bigInt({ min: 1n, max: 5_000n });

const opGroupArb: fc.Arbitrary<OpGroup> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("transfer" as const), txUuid: fc.uuid(), fromIdx: idxArb, toIdx: idxArb, amount: amountArb, duplicateResubmit: fc.boolean(), hijack: fc.boolean(), hijackToIdx: idxArb, hijackAmount: amountArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("selfPayment" as const), txUuid: fc.uuid(), idx: idxArb, amount: amountArb }) },
  // amount <= 0 -- reservations/transfers' own CHECK (amount > 0) constraints
  // (migrations 004, 016) are what actually stop this, not application code.
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("boundaryAmount" as const), txUuid: fc.uuid(), fromIdx: idxArb, toIdx: idxArb, amount: fc.bigInt({ min: -5_000n, max: 0n }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("faulted" as const), txUuid: fc.uuid(), fromIdx: idxArb, toIdx: idxArb, amount: amountArb }) },
);

const KNOWN_ERROR_NAMES = new Set(["MockBankFault"]);
// Postgres error codes this generator is expected to trigger, never anything
// else: 23514 = CHECK constraint (boundaryAmount, non-mint negative-balance
// guards elsewhere), 23505 = UNIQUE constraint (selfPayment's same tx_uuid +
// same account_id on both journal legs, journal's own UNIQUE(tx_uuid,
// account_id) -- CLAUDE.md §5's structural self-payment defense).
const KNOWN_PG_ERROR_CODES = new Set(["23514", "23505"]);

function isExpectedRejection(err: unknown): boolean {
  if (err instanceof MockBankFault) return true;
  if (err instanceof Error && KNOWN_ERROR_NAMES.has(err.name)) return true;
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return KNOWN_PG_ERROR_CODES.has(err.code);
  }
  return false;
}

describe("MockBankAdapter property-based adversarial batch", () => {
  it(
    "any generated batch of transfers/duplicates/hijacks/self-payments/boundary-amounts/faults leaves the ledger balanced",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(opGroupArb, { minLength: 5, maxLength: 15 }), async (groups) => {
          const pool = await Promise.all(Array.from({ length: POOL_SIZE }, () => createFundedAccount(STARTING_BALANCE)));

          const calls: Promise<unknown>[] = [];
          for (const g of groups) {
            if (g.kind === "transfer") {
              calls.push(adapter.transfer(g.txUuid, pool[g.fromIdx]!, pool[g.toIdx]!, g.amount, "MAD"));
              if (g.duplicateResubmit) {
                // Byte-identical resubmission of the SAME tx_uuid, fired
                // concurrently with the original -- exercises transfer()'s
                // existing-reservation branch under a real race, not just
                // sequentially after the first call has already settled.
                calls.push(adapter.transfer(g.txUuid, pool[g.fromIdx]!, pool[g.toIdx]!, g.amount, "MAD"));
              }
              if (g.hijack) {
                // Same tx_uuid, different params -- the settlement-slot
                // hijack CLAUDE.md §5 and ADV-01b are named after. Must
                // never succeed with the hijacker's params.
                calls.push(adapter.transfer(g.txUuid, pool[g.fromIdx]!, pool[g.hijackToIdx]!, g.hijackAmount, "MAD"));
              }
            } else if (g.kind === "selfPayment") {
              calls.push(adapter.transfer(g.txUuid, pool[g.idx]!, pool[g.idx]!, g.amount, "MAD"));
            } else if (g.kind === "boundaryAmount") {
              calls.push(adapter.transfer(g.txUuid, pool[g.fromIdx]!, pool[g.toIdx]!, g.amount, "MAD"));
            } else {
              calls.push(faultyAdapter.transfer(g.txUuid, pool[g.fromIdx]!, pool[g.toIdx]!, g.amount, "MAD"));
            }
          }

          const settled = await Promise.allSettled(calls);
          for (const outcome of settled) {
            if (outcome.status === "rejected" && !isExpectedRejection(outcome.reason)) {
              throw outcome.reason;
            }
          }

          const report = await checkLedgerInvariants(db);
          const bigintSafeStringify = (value: unknown) =>
            JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
          expect(report.ok, `invariants violated: ${bigintSafeStringify(report)}`).toBe(true);
        }),
        { numRuns: 20, seed: 424242 },
      );
    },
    60_000,
  );
});

afterAll(async () => {
  await db.destroy();
});

// Follow-up, not built in this pass: a nightly job running this same
// property with a random (not fixed) seed and a much larger numRuns, with
// any failure's seed committed to server/test/seeds/regressions.ts as a
// permanent fixed-seed regression case. Left undone deliberately -- it
// needs a real scheduled CI run to verify the auto-commit-back mechanism
// actually works, which this environment cannot exercise.
