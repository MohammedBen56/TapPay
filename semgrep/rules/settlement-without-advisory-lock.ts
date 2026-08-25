interface FakeTrx {}
declare const db: unknown;
declare const bankAdapter: { transfer(...args: unknown[]): Promise<unknown> };
declare function withAccountAdvisoryLock<T>(db: unknown, accountId: string, fn: (trx: FakeTrx) => Promise<T>): Promise<T>;
declare function withAdvisoryLock<T>(db: unknown, key: number, fn: (trx: FakeTrx) => Promise<T>): Promise<T>;

async function badFulfill(accountId: string, txUuid: string): Promise<void> {
  // ruleid: settlement-without-advisory-lock
  await bankAdapter.transfer(txUuid, accountId, "other", 100n, "MAD", {});
}

async function goodFulfill(accountId: string, txUuid: string): Promise<void> {
  await withAccountAdvisoryLock(db, accountId, async (_trx) => {
    // ok: settlement-without-advisory-lock
    await bankAdapter.transfer(txUuid, accountId, "other", 100n, "MAD", {});
  });
}

async function goodSweep(accountId: string, txUuid: string): Promise<void> {
  // nosemgrep: settlement-without-advisory-lock -- no racy pre-check state, idempotent by deterministic tx_uuid
  await bankAdapter.transfer(txUuid, accountId, "savings", 100n, "MAD", {});
}
