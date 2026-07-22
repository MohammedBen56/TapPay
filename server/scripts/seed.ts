/**
 * Dev-only demo data. No real onboarding/KYC flow exists or is planned for MVP, so
 * this is the only way to get non-zero balances for local testing. Starting balances
 * are ordinary paired journal transfers FROM the mint account (see
 * migrations/001_accounts.cjs), not special-cased credit rows -- every tx_uuid in
 * the ledger, including this seed data, sums to exactly zero. Idempotent: re-running
 * skips accounts that already exist (by email) rather than double-crediting them.
 */
import { randomUUID } from "node:crypto";
import { db, MINT_ACCOUNT_ID } from "../src/db/kysely.js";

const DEMO_ACCOUNTS: Array<{ email: string; startingBalance: bigint }> = [
  { email: "alice@tappay.local", startingBalance: 50_000n }, // 500.00 MAD
  { email: "bob@tappay.local", startingBalance: 50_000n },
];

async function seedAccount(email: string, startingBalance: bigint): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto("accounts")
      .values({ account_id: randomUUID(), user_id: randomUUID(), email, currency: "MAD" })
      .onConflict((oc) => oc.column("email").doNothing())
      .returning("account_id")
      .executeTakeFirst();

    if (!inserted) {
      console.log(`skip ${email}: already seeded`);
      return;
    }

    // Lock the mint account row before crediting anyone from it -- the same
    // pattern MockBankAdapter.transfer() uses (server/src/adapters, Step 3), so
    // seeding participates in the same lock-ordered discipline as every real
    // transfer rather than being a special case.
    await trx
      .selectFrom("accounts")
      .select("account_id")
      .where("account_id", "=", MINT_ACCOUNT_ID)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const txUuid = randomUUID();
    await trx
      .insertInto("journal")
      .values([
        { tx_uuid: txUuid, account_id: MINT_ACCOUNT_ID, amount: -startingBalance, currency: "MAD" },
        { tx_uuid: txUuid, account_id: inserted.account_id, amount: startingBalance, currency: "MAD" },
      ])
      .execute();

    console.log(`seeded ${email} (${inserted.account_id}) with ${startingBalance} minor units MAD`);
  });
}

async function main(): Promise<void> {
  for (const { email, startingBalance } of DEMO_ACCOUNTS) {
    await seedAccount(email, startingBalance);
  }
  await db.destroy();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
