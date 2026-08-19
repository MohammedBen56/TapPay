import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file shares ONE real Postgres database (no per-file schema
    // or transaction-rollback isolation) -- fine as long as every insert
    // anywhere in the suite is a correctly-balanced double-entry pair, which
    // adapter.transfer()/createFundedAccount always produce. It stops being
    // fine the moment a test asserts something about the database's GLOBAL
    // state: ledger/__tests__/invariants.test.ts deliberately inserts an
    // unbalanced row, asserts checkLedgerInvariants() catches it, then
    // deletes it -- and the new adversarial property test
    // (adapters/__tests__/MockBankAdapter.property.test.ts) asserts the same
    // global invariants after every generated batch. Vitest's default
    // (fileParallelism: true, pool: forks) runs test files concurrently in
    // separate processes, so without this, a property-test run's invariant
    // check can land in the split second invariants.test.ts's deliberately-
    // bad row is committed but not yet cleaned up -- a real, not
    // theoretical, cross-file flake once both tests exist. Sequential file
    // execution costs suite wall-clock time; a ledger test suite that can
    // flake on itself costs trust in every other result it reports, which is
    // the more expensive trade.
    fileParallelism: false,
  },
});
