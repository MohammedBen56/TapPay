async function badTransfer(trx: Transaction<Database>, fromId: string, toId: string): Promise<void> {
  // ruleid: lockaccount-without-ordering
  await lockAccount(trx, fromId);
  const balance = await getBalance(trx, fromId);
  await lockAccount(trx, toId);
}

async function goodTransfer(trx: Transaction<Database>, fromId: string, toId: string): Promise<void> {
  // ok: lockaccount-without-ordering
  await lockAccountsInOrder(trx, fromId, toId);
}

async function goodSingleLock(trx: Transaction<Database>, accountId: string): Promise<void> {
  // ok: lockaccount-without-ordering
  await lockAccount(trx, accountId);
}
