/**
 * The single place every one of the ledger's correctness properties is
 * checked. Deliberately factored out so the exact same function backs four
 * different surfaces that must never drift apart from each other: the
 * scheduled production tripwire, the Prometheus gauges, the property-based
 * adversarial test's assertion, and the restore-drill/chaos-experiment
 * post-condition. If any of those checked something slightly different, a
 * bug could pass one and fail another silently -- this module is what makes
 * that impossible by construction.
 *
 * Every query here is read-only and safe to run against a live database with
 * no locking: it observes committed state, it never participates in it.
 */
import { sql, type Kysely } from "kysely";
import { MINT_ACCOUNT_ID, type Database } from "../db/kysely.js";

export interface UnbalancedTransaction {
  tx_uuid: string;
  sum: bigint;
}

export interface MalformedTransaction {
  tx_uuid: string;
  row_count: number;
}

export interface NegativeBalanceAccount {
  account_id: string;
  currency: string;
  balance: bigint;
}

export interface TransferJournalMismatch {
  tx_uuid: string;
}

export interface InvariantReport {
  checkedAt: Date;
  /** SUM(amount) across the entire journal table. Must be exactly 0n. */
  globalImbalance: bigint;
  /** Per-tx_uuid postings that don't sum to zero. A clean globalImbalance
   * does NOT imply this is empty -- two offsetting broken transactions
   * cancel out in the global sum but each still violates the invariant. */
  unbalancedTransactions: UnbalancedTransaction[];
  /** tx_uuids with a journal row count other than exactly 2 -- an orphaned
   * single-leg entry or a duplicate/triple insert. */
  malformedTransactions: MalformedTransaction[];
  /** Non-mint accounts whose journal-derived balance has gone negative.
   * Should never happen: transfer() and commit() check available balance
   * under a row lock before ever inserting a debit. */
  negativeBalanceAccounts: NegativeBalanceAccount[];
  /** transfers rows without a matching, amount-for-amount journal pair --
   * the divergence 016_transfers.cjs's own comment worries about. */
  transferJournalMismatches: TransferJournalMismatch[];
  ok: boolean;
}

export async function checkLedgerInvariants(db: Kysely<Database>): Promise<InvariantReport> {
  const checkedAt = new Date();

  const globalRow = await sql<{ total: bigint | null }>`
    select coalesce(sum(amount), 0) as total from journal
  `.execute(db);
  const globalImbalance = globalRow.rows[0]?.total ?? 0n;

  const unbalancedRows = await sql<{ tx_uuid: string; sum: bigint }>`
    select tx_uuid, sum(amount) as sum
    from journal
    group by tx_uuid
    having sum(amount) <> 0
  `.execute(db);

  const malformedRows = await sql<{ tx_uuid: string; row_count: string }>`
    select tx_uuid, count(*) as row_count
    from journal
    group by tx_uuid
    having count(*) <> 2
  `.execute(db);

  const negativeRows = await sql<{ account_id: string; currency: string; balance: bigint }>`
    select account_id, currency, coalesce(sum(amount), 0) as balance
    from journal
    where account_id <> ${MINT_ACCOUNT_ID}
    group by account_id, currency
    having coalesce(sum(amount), 0) < 0
  `.execute(db);

  const mismatchRows = await sql<{ tx_uuid: string }>`
    select t.tx_uuid
    from transfers t
    where not exists (
      select 1 from journal j
      where j.tx_uuid = t.tx_uuid
        and j.account_id = t.from_account_id
        and j.amount = -t.amount
        and j.currency = t.currency
    )
    or not exists (
      select 1 from journal j
      where j.tx_uuid = t.tx_uuid
        and j.account_id = t.to_account_id
        and j.amount = t.amount
        and j.currency = t.currency
    )
  `.execute(db);

  const unbalancedTransactions = unbalancedRows.rows;
  const malformedTransactions = malformedRows.rows.map((r) => ({ tx_uuid: r.tx_uuid, row_count: Number(r.row_count) }));
  const negativeBalanceAccounts = negativeRows.rows;
  const transferJournalMismatches = mismatchRows.rows;

  const ok =
    globalImbalance === 0n &&
    unbalancedTransactions.length === 0 &&
    malformedTransactions.length === 0 &&
    negativeBalanceAccounts.length === 0 &&
    transferJournalMismatches.length === 0;

  return {
    checkedAt,
    globalImbalance,
    unbalancedTransactions,
    malformedTransactions,
    negativeBalanceAccounts,
    transferJournalMismatches,
    ok,
  };
}
