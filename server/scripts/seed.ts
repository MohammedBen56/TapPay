/**
 * The mock bank's provisioning system (docs/TapPay_v2_Technical_Design.md §6)
 * -- "a bank-issued customer ID + password... as a real bank would provide
 * it." No self-service signup exists or is planned; this script is the only
 * way a customer_credentials row gets created. Idempotent by customer_id:
 * re-running skips any customer whose credentials already exist, and the
 * one-time historical-transfer/beneficiary seeding only runs on customer
 * 10000001's very first creation (see `main()`), so re-running never
 * double-seeds history either.
 *
 * Starting balances and historical transfers are ordinary paired journal
 * rows credited FROM the mint account (migrations/001_accounts.cjs) with
 * matching transfers rows for the reference -- not special-cased, so every
 * tx_uuid in the ledger, including this seed data, genuinely sums to zero
 * and genuinely has a reference, exactly like a real settled transfer.
 */
import { randomUUID } from "node:crypto";
import { buildRib } from "@tappay/shared";
import { hashPassword } from "../src/auth/passwords.js";
import { db, MINT_ACCOUNT_ID } from "../src/db/kysely.js";

const DEMO_PASSWORD = "Demo#2026";

interface DemoCustomer {
  customerId: string;
  displayName: string;
  email: string;
  rib: string;
  startingBalance: bigint; // minor units
}

const DEMO_CUSTOMERS: DemoCustomer[] = [
  {
    customerId: "10000001",
    displayName: "Yasmine Idrissi",
    email: "10000001@tappay.local",
    rib: buildRib("780", "0000000000001001"),
    startingBalance: 1_250_000n, // 12,500.00 MAD
  },
  {
    customerId: "10000002",
    displayName: "Karim Bennani",
    email: "10000002@tappay.local",
    rib: buildRib("780", "0000000000001002"),
    startingBalance: 342_050n, // 3,420.50 MAD
  },
  {
    customerId: "10000003",
    displayName: "Sofia Alaoui",
    email: "10000003@tappay.local",
    rib: buildRib("780", "0000000000001003"),
    startingBalance: 8_700_000n, // 87,000.00 MAD
  },
  {
    customerId: "10000004",
    displayName: "Omar Tazi",
    email: "10000004@tappay.local",
    rib: buildRib("780", "0000000000001004"),
    startingBalance: 0n, // deliberately empty -- exercises the Home screen's empty state
  },
  {
    customerId: "10000005",
    displayName: "Nadia Chraibi",
    email: "10000005@tappay.local",
    rib: buildRib("780", "0000000000001005"),
    startingBalance: 25_000n, // 250.00 MAD
  },
];

interface SeededAccount {
  accountId: string;
  userId: string;
}

/** Returns the newly created account_id/user_id, or null if this
 * customer_id was already provisioned by a prior run. */
async function seedCustomer(customer: DemoCustomer): Promise<SeededAccount | null> {
  const alreadySeeded = await db
    .selectFrom("customer_credentials")
    .select("customer_id")
    .where("customer_id", "=", customer.customerId)
    .executeTakeFirst();
  if (alreadySeeded) {
    console.log(`skip ${customer.customerId} (${customer.displayName}): already seeded`);
    return null;
  }

  const accountId = randomUUID();
  const userId = randomUUID();
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await db.transaction().execute(async (trx) => {
    // Ship List v2 Phase 8: identity (email/display_name) lives on `users`
    // now, created before the accounts row that references it.
    await trx.insertInto("users").values({ user_id: userId, email: customer.email, display_name: customer.displayName }).execute();
    await trx
      .insertInto("accounts")
      .values({
        account_id: accountId,
        user_id: userId,
        currency: "MAD",
        rib: customer.rib,
      })
      .execute();
    await trx
      .insertInto("customer_credentials")
      .values({ customer_id: customer.customerId, user_id: userId, password_hash: passwordHash })
      .execute();

    if (customer.startingBalance > 0n) {
      // Same lock-ordered discipline as every real transfer (MockBankAdapter,
      // server/src/adapters) -- lock the mint row before crediting from it.
      await trx.selectFrom("accounts").select("account_id").where("account_id", "=", MINT_ACCOUNT_ID).forUpdate().executeTakeFirstOrThrow();

      const txUuid = randomUUID();
      await trx
        .insertInto("journal")
        .values([
          { tx_uuid: txUuid, account_id: MINT_ACCOUNT_ID, amount: -customer.startingBalance, currency: "MAD" },
          { tx_uuid: txUuid, account_id: accountId, amount: customer.startingBalance, currency: "MAD" },
        ])
        .execute();
    }
  });

  console.log(`seeded ${customer.customerId} (${customer.displayName}, ${accountId}) -- RIB ${customer.rib}`);
  return { accountId, userId };
}

/** A historical, already-settled transfer, backdated `daysAgo` -- written
 * directly (not through MockBankAdapter, which stamps now() and injects
 * 200-800ms of fake latency per call) so 15 of these seed instantly with
 * realistic, spread-out timestamps. Still a genuine sum-to-zero journal pair
 * with a matching transfers row, exactly like a real settlement -- just with
 * an explicit created_at instead of the DB default. */
async function seedHistoricalTransfer(
  fromAccountId: string,
  toAccountId: string,
  amountMinor: bigint,
  reference: string,
  daysAgo: number,
): Promise<void> {
  const txUuid = randomUUID();
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("journal")
      .values([
        { tx_uuid: txUuid, account_id: fromAccountId, amount: -amountMinor, currency: "MAD", created_at: createdAt },
        { tx_uuid: txUuid, account_id: toAccountId, amount: amountMinor, currency: "MAD", created_at: createdAt },
      ])
      .execute();
    await trx
      .insertInto("transfers")
      .values({
        tx_uuid: txUuid,
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        amount: amountMinor,
        currency: "MAD",
        reference,
        created_at: createdAt,
      })
      .execute();
  });
}

/** Ship List v2 Wave 3 (self-review hardening pass): a historical bill
 * payment, seeded the same way seedHistoricalTransfer is -- direct
 * journal+transfers insert, not through MockBankAdapter -- plus the
 * matching bill_payments row `billPayments.ts` would have written as its
 * second, best-effort statement. Looks the biller up by name (migration
 * 018's catalog, not re-typed here) rather than hardcoding its account id.
 * Backdating 2-3 of these to the same biller/amount roughly a month apart
 * is what gives subscriptions.ts's detector (>=2 occurrences, 25-35 day
 * gap) something real to find in a fresh demo, not just a P2P history. */
async function seedHistoricalBillPayment(
  customerAccountId: string,
  billerName: string,
  amountMinor: bigint,
  subscriberReference: string,
  daysAgo: number,
): Promise<void> {
  const biller = await db.selectFrom("billers").select(["id", "account_id", "category", "name"]).where("name", "=", billerName).executeTakeFirstOrThrow();
  const txUuid = randomUUID();
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const reference = `${biller.name} -- ${subscriberReference}`;

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("journal")
      .values([
        { tx_uuid: txUuid, account_id: customerAccountId, amount: -amountMinor, currency: "MAD", created_at: createdAt },
        { tx_uuid: txUuid, account_id: biller.account_id, amount: amountMinor, currency: "MAD", created_at: createdAt },
      ])
      .execute();
    await trx
      .insertInto("transfers")
      .values({
        tx_uuid: txUuid,
        from_account_id: customerAccountId,
        to_account_id: biller.account_id,
        amount: amountMinor,
        currency: "MAD",
        reference,
        created_at: createdAt,
      })
      .execute();
    await trx
      .insertInto("bill_payments")
      .values({ tx_uuid: txUuid, account_id: customerAccountId, biller_id: biller.id, subscriber_reference: subscriberReference, created_at: createdAt })
      .execute();
  });
}

async function seedBeneficiary(ownerUserId: string, displayName: string, rib: string): Promise<void> {
  await db
    .insertInto("beneficiaries")
    .values({ owner_user_id: ownerUserId, display_name: displayName, rib })
    .onConflict((oc) => oc.columns(["owner_user_id", "rib"]).doNothing())
    .execute();
}

/** Migration 001 creates the mint account with no display_name (that column
 * didn't exist until migration 012) -- left null, it shows as "Unknown" in
 * a customer's transaction history for their starting-balance funding entry
 * (a real, legitimate journal row, just with a nameless counterparty).
 * Idempotent, safe to run every time. */
async function ensureMintAccountDisplayName(): Promise<void> {
  await db
    .updateTable("users")
    .set({ display_name: "TapPay" })
    .where("user_id", "=", MINT_ACCOUNT_ID)
    .where("display_name", "is", null)
    .execute();
}

async function main(): Promise<void> {
  await ensureMintAccountDisplayName();

  const seeded: SeededAccount[] = [];
  let freshRun = false;

  for (const [index, customer] of DEMO_CUSTOMERS.entries()) {
    const result = await seedCustomer(customer);
    if (index === 0 && result) freshRun = true; // gate one-time history/beneficiary seeding
    seeded.push(
      result ??
        (await db
          .selectFrom("accounts")
          .innerJoin("customer_credentials", "customer_credentials.user_id", "accounts.user_id")
          .select(["accounts.account_id as accountId", "accounts.user_id as userId"])
          .where("customer_credentials.customer_id", "=", customer.customerId)
          .executeTakeFirstOrThrow()),
    );
  }

  if (!freshRun) {
    console.log("history/beneficiaries already seeded, skipping");
    await db.destroy();
    return;
  }

  const [yasmine, karim, sofia, omar, nadia] = seeded as [SeededAccount, SeededAccount, SeededAccount, SeededAccount, SeededAccount];

  // ~45 historical transfers between the demo customers, spread over ~3
  // months (not ~6 weeks) -- found via a self-review audit as the single
  // highest-leverage fix for how thin a live client walkthrough looked:
  // a handful of rows over 6 weeks reads as a toy, not a used account.
  // Includes three deliberately recurring loyer (rent) payments at ~30-day
  // intervals so subscriptions.ts's detector has real P2P history to find
  // too, not just billers below.
  await Promise.all([
    seedHistoricalTransfer(yasmine.accountId, karim.accountId, 420_000n, "Loyer Août", 4),
    seedHistoricalTransfer(sofia.accountId, yasmine.accountId, 18_000n, "Remboursement déjeuner", 6),
    seedHistoricalTransfer(yasmine.accountId, nadia.accountId, 62_000n, "Facture #1042", 9),
    seedHistoricalTransfer(karim.accountId, yasmine.accountId, 50_000n, "Cadeau anniversaire", 15),
    seedHistoricalTransfer(yasmine.accountId, sofia.accountId, 120_000n, "Acompte projet", 18),
    seedHistoricalTransfer(nadia.accountId, karim.accountId, 35_000n, "Covoiturage", 21),
    seedHistoricalTransfer(sofia.accountId, nadia.accountId, 250_000n, "Loyer Juillet", 25),
    seedHistoricalTransfer(karim.accountId, sofia.accountId, 15_000n, "Café", 28),
    seedHistoricalTransfer(yasmine.accountId, karim.accountId, 80_000n, "Réparation voiture", 30),
    seedHistoricalTransfer(nadia.accountId, yasmine.accountId, 45_000n, "Remboursement voyage", 33),
    seedHistoricalTransfer(sofia.accountId, karim.accountId, 300_000n, "Investissement commun", 36),
    seedHistoricalTransfer(karim.accountId, nadia.accountId, 22_000n, "Anniversaire Sami", 39),
    seedHistoricalTransfer(yasmine.accountId, sofia.accountId, 95_000n, "Facture #0981", 41),
    seedHistoricalTransfer(nadia.accountId, sofia.accountId, 250_000n, "Loyer Juin", 44),
    seedHistoricalTransfer(karim.accountId, yasmine.accountId, 27_000n, "Remboursement resto", 46),
    seedHistoricalTransfer(sofia.accountId, karim.accountId, 40_000n, "Courses Marjane", 49),
    seedHistoricalTransfer(nadia.accountId, karim.accountId, 8_500n, "Taxi aéroport", 51),
    seedHistoricalTransfer(yasmine.accountId, nadia.accountId, 150_000n, "Facture #0955", 53),
    seedHistoricalTransfer(karim.accountId, sofia.accountId, 60_000n, "Remboursement resto", 56),
    seedHistoricalTransfer(sofia.accountId, yasmine.accountId, 22_500n, "Anniversaire", 58),
    seedHistoricalTransfer(nadia.accountId, yasmine.accountId, 33_000n, "Covoiturage", 61),
    seedHistoricalTransfer(karim.accountId, nadia.accountId, 250_000n, "Loyer Mai", 64),
    seedHistoricalTransfer(yasmine.accountId, sofia.accountId, 12_000n, "Café", 66),
    seedHistoricalTransfer(sofia.accountId, nadia.accountId, 45_000n, "Cadeau naissance", 69),
    seedHistoricalTransfer(karim.accountId, yasmine.accountId, 18_000n, "Remboursement déjeuner", 71),
    seedHistoricalTransfer(nadia.accountId, sofia.accountId, 70_000n, "Facture #0912", 74),
    seedHistoricalTransfer(yasmine.accountId, karim.accountId, 55_000n, "Sortie cinéma", 77),
    seedHistoricalTransfer(sofia.accountId, karim.accountId, 26_000n, "Courses Marjane", 79),
    seedHistoricalTransfer(karim.accountId, nadia.accountId, 90_000n, "Acompte mariage", 82),
    seedHistoricalTransfer(nadia.accountId, karim.accountId, 15_000n, "Café", 85),
    seedHistoricalTransfer(yasmine.accountId, sofia.accountId, 200_000n, "Remboursement prêt", 88),
    // Four recurring rent payments, ~30 days apart, same pair/amount -- a
    // real subscription-shaped P2P pattern for subscriptions.ts to detect,
    // not just billers below.
    seedHistoricalTransfer(karim.accountId, nadia.accountId, 350_000n, "Loyer", 2),
    seedHistoricalTransfer(karim.accountId, nadia.accountId, 350_000n, "Loyer", 32),
    seedHistoricalTransfer(karim.accountId, nadia.accountId, 350_000n, "Loyer", 62),
    seedHistoricalTransfer(karim.accountId, nadia.accountId, 350_000n, "Loyer", 92),
  ]);
  console.log("seeded 35 historical transfers");

  // A handful of real bill payments per customer -- billPayments.ts's own
  // catalog (migration 018), not a fictional stand-in. Atlas Power Co. and
  // NexaNet Broadband are each paid 2-3 times ~30 days apart by the same
  // customer specifically so both subscriptions.ts's detector AND Home's
  // biller-flagged transaction rows (is_biller/biller_category) have
  // something real to show in a fresh demo, not an empty GET
  // /bill-payments and an empty Subscriptions screen.
  await Promise.all([
    seedHistoricalBillPayment(yasmine.accountId, "Atlas Power Co.", 34_500n, "SUB-10000001-E", 3),
    seedHistoricalBillPayment(yasmine.accountId, "Atlas Power Co.", 31_200n, "SUB-10000001-E", 33),
    seedHistoricalBillPayment(yasmine.accountId, "Atlas Power Co.", 29_800n, "SUB-10000001-E", 63),
    seedHistoricalBillPayment(yasmine.accountId, "NexaNet Broadband", 19_900n, "SUB-10000001-N", 12),
    seedHistoricalBillPayment(yasmine.accountId, "NexaNet Broadband", 19_900n, "SUB-10000001-N", 42),
    seedHistoricalBillPayment(karim.accountId, "Bluewell Water Utilities", 12_400n, "SUB-10000002-W", 8),
    seedHistoricalBillPayment(karim.accountId, "Bluewell Water Utilities", 11_100n, "SUB-10000002-W", 38),
    seedHistoricalBillPayment(sofia.accountId, "Skyline Telecom", 24_900n, "SUB-10000003-T", 5),
    seedHistoricalBillPayment(sofia.accountId, "Skyline Telecom", 24_900n, "SUB-10000003-T", 35),
    seedHistoricalBillPayment(sofia.accountId, "Skyline Telecom", 24_900n, "SUB-10000003-T", 65),
    seedHistoricalBillPayment(nadia.accountId, "Northline Electric", 27_600n, "SUB-10000005-E", 14),
  ]);
  console.log("seeded 11 historical bill payments");

  // 2-3 cross-referencing beneficiaries per customer, so the Send flow's
  // contacts list is never empty on first launch. owner_user_id, not
  // account_id -- beneficiaries.owner_user_id FKs to accounts(user_id).
  await Promise.all([
    seedBeneficiary(yasmine.userId, "Karim Bennani", DEMO_CUSTOMERS[1]!.rib),
    seedBeneficiary(yasmine.userId, "Sofia Alaoui", DEMO_CUSTOMERS[2]!.rib),
    seedBeneficiary(karim.userId, "Yasmine Idrissi", DEMO_CUSTOMERS[0]!.rib),
    seedBeneficiary(karim.userId, "Nadia Chraibi", DEMO_CUSTOMERS[4]!.rib),
    seedBeneficiary(sofia.userId, "Yasmine Idrissi", DEMO_CUSTOMERS[0]!.rib),
    seedBeneficiary(sofia.userId, "Nadia Chraibi", DEMO_CUSTOMERS[4]!.rib),
    seedBeneficiary(omar.userId, "Yasmine Idrissi", DEMO_CUSTOMERS[0]!.rib),
    seedBeneficiary(omar.userId, "Karim Bennani", DEMO_CUSTOMERS[1]!.rib),
    seedBeneficiary(nadia.userId, "Sofia Alaoui", DEMO_CUSTOMERS[2]!.rib),
    seedBeneficiary(nadia.userId, "Karim Bennani", DEMO_CUSTOMERS[1]!.rib),
  ]);
  console.log("seeded beneficiaries");

  console.log("\nDemo credentials (all share one password for local dev):");
  console.log(`  password: ${DEMO_PASSWORD}`);
  for (const c of DEMO_CUSTOMERS) {
    console.log(`  customer_id: ${c.customerId}  (${c.displayName})`);
  }

  await db.destroy();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
