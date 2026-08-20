import type { FastifyInstance } from "fastify";
import { accountIdQuerySchema } from "./me.js";
import { resolveOwnedAccount } from "./accountSelection.js";
import { db } from "../db/kysely.js";

// Heuristic constants, not tunable via config -- this is a read-only,
// best-effort pattern detector (no write path, no money at stake), unlike
// every other threshold in this codebase (CLAUDE.md §8's "config over
// constants" rule is about behavior that changes what money does or who
// gets in; this only changes what gets displayed).
const LOOKBACK_MS = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months
const MIN_OCCURRENCES = 2;
const MONTHLY_INTERVAL_MIN_DAYS = 25;
const MONTHLY_INTERVAL_MAX_DAYS = 35;

export interface DetectedSubscription {
  counterparty_account_id: string;
  counterparty_name: string | null;
  amount: string;
  currency: string;
  occurrences: number;
  last_paid_at: string;
  average_interval_days: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Ship List v2 Wave 2 Phase 5: subscription tracking. Pure read-only
 * detection over existing `journal`/`accounts` history -- no new table, no
 * write path. Groups the account's own outbound debits by (counterparty,
 * amount) and flags a group as a likely subscription when it has recurred
 * at least twice with a roughly-monthly cadence (25-35 day median gap
 * between occurrences). A real pattern-matching heuristic, not a
 * guarantee -- a one-off coincidence of two same-amount payments to the
 * same recipient a month apart would false-positive, and a genuine
 * subscription whose price changed would false-negative (amount is part
 * of the grouping key, deliberately -- a subscription's defining
 * characteristic here is "the same charge, recurring," not just "the same
 * merchant").
 */
export interface DebitRow {
  amount: bigint;
  currency: string;
  created_at: Date;
  counterparty_account_id: string;
  counterparty_name: string | null;
}

/** The actual detection logic, factored out from the DB query below
 * specifically so it's unit-testable with fabricated timestamps -- the
 * app's own DB role (`tappay_app`) has no UPDATE on `journal`
 * (migration 017's append-only grant), so a test can't backdate real
 * rows to exercise "roughly monthly" the way it could with a live
 * multi-month history. `rows` must arrive oldest-first, matching the
 * query's own `ORDER BY j.created_at ASC`. */
export function groupIntoSubscriptions(rows: DebitRow[]): DetectedSubscription[] {
  const groups = new Map<
    string,
    { amount: bigint; currency: string; counterpartyAccountId: string; counterpartyName: string | null; occurredAt: Date[] }
  >();
  for (const row of rows) {
    const key = `${row.counterparty_account_id}:${(-row.amount).toString()}:${row.currency}`;
    const group = groups.get(key);
    if (group) {
      group.occurredAt.push(row.created_at);
    } else {
      groups.set(key, {
        amount: -row.amount,
        currency: row.currency,
        counterpartyAccountId: row.counterparty_account_id,
        counterpartyName: row.counterparty_name,
        occurredAt: [row.created_at],
      });
    }
  }

  const detected: DetectedSubscription[] = [];
  for (const group of groups.values()) {
    if (group.occurredAt.length < MIN_OCCURRENCES) continue;
    const gapsDays: number[] = [];
    for (let i = 1; i < group.occurredAt.length; i++) {
      gapsDays.push((group.occurredAt[i]!.getTime() - group.occurredAt[i - 1]!.getTime()) / (24 * 60 * 60 * 1000));
    }
    const medianGap = median(gapsDays);
    if (medianGap < MONTHLY_INTERVAL_MIN_DAYS || medianGap > MONTHLY_INTERVAL_MAX_DAYS) continue;

    detected.push({
      counterparty_account_id: group.counterpartyAccountId,
      counterparty_name: group.counterpartyName,
      amount: group.amount.toString(),
      currency: group.currency,
      occurrences: group.occurredAt.length,
      last_paid_at: group.occurredAt[group.occurredAt.length - 1]!.toISOString(),
      average_interval_days: Math.round(medianGap),
    });
  }

  // Most recently paid first -- the ones still actively recurring right
  // now are the most actionable to show.
  detected.sort((a, b) => (a.last_paid_at < b.last_paid_at ? 1 : -1));
  return detected;
}

export async function detectSubscriptions(accountId: string): Promise<DetectedSubscription[]> {
  const rows = await db
    .selectFrom("journal as j")
    .innerJoin("journal as o", (join) => join.onRef("o.tx_uuid", "=", "j.tx_uuid").onRef("o.account_id", "!=", "j.account_id"))
    .leftJoin("accounts as counterparty", "counterparty.account_id", "o.account_id")
    .leftJoin("users as counterparty_user", "counterparty_user.user_id", "counterparty.user_id")
    .select([
      "j.amount as amount",
      "j.currency as currency",
      "j.created_at as created_at",
      "o.account_id as counterparty_account_id",
      "counterparty_user.display_name as counterparty_name",
    ])
    .where("j.account_id", "=", accountId)
    .where("j.amount", "<", 0n)
    .where("j.created_at", ">=", new Date(Date.now() - LOOKBACK_MS))
    .orderBy("j.created_at", "asc")
    .execute();

  return groupIntoSubscriptions(rows);
}

export function registerSubscriptionRoutes(app: FastifyInstance): void {
  app.get("/subscriptions", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId } = request.user;
    const parsed = accountIdQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const account = await resolveOwnedAccount(userId, parsed.data.account_id);
    if (!account) {
      return reply.status(404).send({ error: "NotFound", message: "no such account" });
    }

    const subscriptions = await detectSubscriptions(account.account_id);
    return reply.send({ subscriptions });
  });
}
