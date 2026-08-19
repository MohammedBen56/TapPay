async function badLock(accountId: string): Promise<void> {
  // ruleid: no-forupdate-outside-transaction
  const row = await db
    .selectFrom("accounts")
    .select("account_id")
    .where("account_id", "=", accountId)
    .forUpdate()
    .executeTakeFirst();
}

async function goodLock(trx: Transaction<Database>, accountId: string): Promise<void> {
  // ok: no-forupdate-outside-transaction
  const row = await trx
    .selectFrom("accounts")
    .select("account_id")
    .where("account_id", "=", accountId)
    .forUpdate()
    .executeTakeFirst();
}
