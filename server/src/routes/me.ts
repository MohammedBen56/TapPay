import { ribToIban } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { recordAudit } from "../audit/log.js";
import { db } from "../db/kysely.js";
import { resolveOwnedAccount } from "./accountSelection.js";
import { createCursorCodec } from "./cursor.js";

// Ship List v2's data-export route reads every one of a customer's own
// transaction/bill-payment rows in a single response, deliberately not
// paginated -- a data-rights export is a complete snapshot, not something
// meant to be browsed incrementally. Capped rather than truly unbounded:
// a customer with more than this many lifetime transactions would need
// the async-job-based export the Ship List's own Recommended bucket
// already names (generate off the request path, notify when ready) --
// not a problem this demo-scale app's seeded data will ever hit, but the
// cap documents the real limitation rather than silently having one.
const DATA_EXPORT_ROW_CAP = 10_000;

// A statement covers a bounded date range (Ship List v2 item #4, owner-
// requested -- "export a transaction of past few months for official
// purposes like applying to visa"), unlike the data-export route above,
// which is a full-lifetime snapshot. Capped defensively for the same
// reason DATA_EXPORT_ROW_CAP is: a demo-scale account will never approach
// this within any real statement period.
const STATEMENT_ROW_CAP = 5_000;

// Ship List v2 Phase 8: every account-scoped GET accepts this same
// optional `account_id`, resolved via accountSelection.ts's ownership
// check. Absent -> the caller's checking account (unchanged behavior).
export const accountIdQuerySchema = z.object({ account_id: z.string().uuid().optional() });

export const transactionsQuerySchema = accountIdQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().optional(),
});

export const statementQuerySchema = accountIdQuerySchema
  .extend({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  })
  .refine((q) => new Date(q.from) <= new Date(q.to), { message: "from must not be after to" });

const cursorCodec = createCursorCodec<bigint>(
  (id) => id.toString(),
  (s) => {
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  },
);

/** GET /me, and the account-scoped reads (balance, transaction history,
 * statement, data export) that make up the Home screen (docs/
 * TapPay_v2_Technical_Design.md §5). Every route here resolves its account
 * from the access token's `sub` claim via accountSelection.ts's ownership
 * check -- a `?account_id=` is accepted (Ship List v2 Phase 8, multiple
 * accounts per customer) but always checked against the caller's own
 * `user_id` first, never trusted bare (CLAUDE.md §5). Unlike the parked
 * `GET /accounts/:accountId/balance` this replaces functionally (that
 * route stays live too, unauthenticated, until nothing references it --
 * see routes/tx.ts's own doc comment), there is zero IDOR surface here. */
export function registerMeRoutes(app: FastifyInstance): void {
  app.get("/me", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId, cid: customerId } = request.user;
    const parsed = accountIdQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const account = await resolveOwnedAccount(userId, parsed.data.account_id);

    if (!account || !account.rib || !account.display_name) {
      // A real logged-in customer always has both -- seed.ts sets them at
      // provisioning time. Fail closed rather than expose a partial profile.
      return reply.status(404).send({ error: "IncompleteProfile", message: "account profile is missing required fields" });
    }

    return reply.send({
      customer_id: customerId,
      display_name: account.display_name,
      account_id: account.account_id,
      account_type: account.account_type,
      rib: account.rib,
      iban: ribToIban(account.rib),
      currency: account.currency,
    });
  });

  app.get("/accounts/me/balance", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId } = request.user;
    const parsed = accountIdQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const account = await resolveOwnedAccount(userId, parsed.data.account_id);
    if (!account) {
      return reply.status(404).send({ error: "NotFound", message: "no such account" });
    }
    const { currency } = request.query as { currency?: string };
    const resolvedCurrency = currency ?? account.currency;
    const balance = await bankAdapter.getAvailableBalance(account.account_id, resolvedCurrency);
    return reply.send({
      account_id: account.account_id,
      account_type: account.account_type,
      currency: resolvedCurrency,
      available_balance: balance.toString(),
    });
  });

  app.get("/accounts/me/transactions", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId } = request.user;
    const parsed = transactionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { limit, before, account_id } = parsed.data;
    const account = await resolveOwnedAccount(userId, account_id);
    if (!account) {
      return reply.status(404).send({ error: "NotFound", message: "no such account" });
    }
    const accountId = account.account_id;

    let cursor: { createdAt: Date; tiebreak: bigint } | null = null;
    if (before !== undefined) {
      cursor = cursorCodec.decode(before);
      if (!cursor) {
        return reply.status(400).send({ error: "InvalidRequest", message: "malformed cursor" });
      }
    }

    // Self-join on tx_uuid to find the counterparty's own journal row for the
    // same transaction (exactly one other row per tx_uuid -- self-payment is
    // structurally impossible, CLAUDE.md §5). LEFT JOIN transfers so seeded
    // or legacy rows with no reference still render, just with a null one.
    // LEFT JOIN billers on the counterparty's account_id so a bill payment's
    // counterparty (which IS just an accounts row, see 018_billers.cjs) is
    // additionally flagged as one -- lets the mobile client render a bill
    // category icon instead of the generic person avatar. The counterparty's
    // display_name now lives on `users` (Ship List v2 Phase 8), so the
    // counterparty join goes one hop further: accounts -> users.
    let query = db
      .selectFrom("journal as j")
      .innerJoin("journal as o", (join) => join.onRef("o.tx_uuid", "=", "j.tx_uuid").on("o.account_id", "!=", accountId))
      .leftJoin("accounts as counterparty", "counterparty.account_id", "o.account_id")
      .leftJoin("users as counterparty_user", "counterparty_user.user_id", "counterparty.user_id")
      .leftJoin("transfers as t", "t.tx_uuid", "j.tx_uuid")
      .leftJoin("billers as bl", "bl.account_id", "o.account_id")
      .select([
        "j.id as id",
        "j.tx_uuid as tx_uuid",
        "j.amount as amount",
        "j.currency as currency",
        "j.created_at as created_at",
        "counterparty_user.display_name as counterparty_name",
        "counterparty.rib as counterparty_rib",
        "t.reference as reference",
        "bl.category as biller_category",
      ])
      .where("j.account_id", "=", accountId)
      .orderBy("j.created_at", "desc")
      .orderBy("j.id", "desc")
      .limit(limit + 1);

    if (cursor) {
      const { createdAt, tiebreak: id } = cursor;
      query = query.where((eb) =>
        eb.or([eb("j.created_at", "<", createdAt), eb.and([eb("j.created_at", "=", createdAt), eb("j.id", "<", id)])]),
      );
    }

    const rows = await query.execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return reply.send({
      transactions: page.map((r) => ({
        tx_uuid: r.tx_uuid,
        direction: r.amount < 0n ? "debit" : "credit",
        amount: (r.amount < 0n ? -r.amount : r.amount).toString(),
        currency: r.currency,
        counterparty_name: r.counterparty_name,
        counterparty_rib: r.counterparty_rib,
        reference: r.reference,
        created_at: r.created_at.toISOString(),
        is_biller: r.biller_category !== null,
        biller_category: r.biller_category,
      })),
      next_cursor: hasMore && last ? cursorCodec.encode(last.created_at, last.id) : null,
    });
  });

  // Ship List v2 -- a customer's own data, in one authenticated, self-
  // scoped response: derisks a data-protection-law conversation (Morocco's
  // Law 09-08, GDPR-equivalent right-of-access) at near-zero cost, since
  // every underlying query already exists elsewhere in this file/
  // billPayments.ts -- this just bundles them. Audit-logged like every
  // other sensitive action (server/src/audit/log.ts).
  app.get("/me/data-export", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId, cid: customerId } = request.user;
    const parsed = accountIdQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const account = await resolveOwnedAccount(userId, parsed.data.account_id);
    if (!account) {
      return reply.status(404).send({ error: "IncompleteProfile", message: "account profile is missing required fields" });
    }
    const accountId = account.account_id;

    const [transactions, billPayments, beneficiaries] = await Promise.all([
      db
        .selectFrom("journal as j")
        .innerJoin("journal as o", (join) => join.onRef("o.tx_uuid", "=", "j.tx_uuid").on("o.account_id", "!=", accountId))
        .leftJoin("accounts as counterparty", "counterparty.account_id", "o.account_id")
        .leftJoin("users as counterparty_user", "counterparty_user.user_id", "counterparty.user_id")
        .leftJoin("transfers as t", "t.tx_uuid", "j.tx_uuid")
        .select([
          "j.tx_uuid as tx_uuid",
          "j.amount as amount",
          "j.currency as currency",
          "j.created_at as created_at",
          "counterparty_user.display_name as counterparty_name",
          "counterparty.rib as counterparty_rib",
          "t.reference as reference",
        ])
        .where("j.account_id", "=", accountId)
        .orderBy("j.created_at", "desc")
        .limit(DATA_EXPORT_ROW_CAP)
        .execute(),
      db
        .selectFrom("bill_payments as bp")
        .innerJoin("billers as b", "b.id", "bp.biller_id")
        .innerJoin("transfers as t", "t.tx_uuid", "bp.tx_uuid")
        .select(["bp.tx_uuid as tx_uuid", "b.name as biller_name", "bp.subscriber_reference as subscriber_reference", "t.amount as amount", "t.currency as currency", "bp.created_at as created_at"])
        .where("bp.account_id", "=", accountId)
        .orderBy("bp.created_at", "desc")
        .limit(DATA_EXPORT_ROW_CAP)
        .execute(),
      db.selectFrom("beneficiaries").select(["display_name", "rib", "created_at"]).where("owner_user_id", "=", userId).execute(),
    ]);

    await recordAudit({ userId, action: "data_export.request", resourceType: "account", resourceId: accountId, ip: request.ip });

    return reply.send({
      exported_at: new Date().toISOString(),
      profile: {
        customer_id: customerId,
        display_name: account.display_name,
        account_id: accountId,
        account_type: account.account_type,
        rib: account.rib,
        currency: account.currency,
        account_created_at: account.created_at.toISOString(),
      },
      transactions: transactions.map((r) => ({
        tx_uuid: r.tx_uuid,
        direction: r.amount < 0n ? "debit" : "credit",
        amount: (r.amount < 0n ? -r.amount : r.amount).toString(),
        currency: r.currency,
        counterparty_name: r.counterparty_name,
        counterparty_rib: r.counterparty_rib,
        reference: r.reference,
        created_at: r.created_at.toISOString(),
      })),
      bill_payments: billPayments.map((r) => ({
        tx_uuid: r.tx_uuid,
        biller_name: r.biller_name,
        subscriber_reference: r.subscriber_reference,
        amount: r.amount.toString(),
        currency: r.currency,
        created_at: r.created_at.toISOString(),
      })),
      beneficiaries: beneficiaries.map((b) => ({
        display_name: b.display_name,
        rib: b.rib,
        created_at: b.created_at.toISOString(),
      })),
    });
  });

  // Ship List v2's owner-requested statement export -- a date-ranged,
  // itemized view with opening/closing balance, the shape a real bank
  // statement (and the mobile PDF built from this response) needs. `to` is
  // treated as inclusive through end-of-day, matching how a customer picks
  // a calendar date range, not an exact instant.
  app.get("/accounts/me/statement", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId, cid: customerId } = request.user;
    const parsed = statementQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { from, to, account_id } = parsed.data;
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDateExclusive = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);

    const account = await resolveOwnedAccount(userId, account_id);
    if (!account || !account.rib || !account.display_name) {
      return reply.status(404).send({ error: "IncompleteProfile", message: "account profile is missing required fields" });
    }
    const accountId = account.account_id;

    const [openingRow, rangeRows] = await Promise.all([
      db
        .selectFrom("journal")
        .select((eb) => eb.fn.sum<bigint>("amount").as("total"))
        .where("account_id", "=", accountId)
        .where("currency", "=", account.currency)
        .where("created_at", "<", fromDate)
        .executeTakeFirst(),
      db
        .selectFrom("journal as j")
        .innerJoin("journal as o", (join) => join.onRef("o.tx_uuid", "=", "j.tx_uuid").on("o.account_id", "!=", accountId))
        .leftJoin("accounts as counterparty", "counterparty.account_id", "o.account_id")
        .leftJoin("users as counterparty_user", "counterparty_user.user_id", "counterparty.user_id")
        .leftJoin("transfers as t", "t.tx_uuid", "j.tx_uuid")
        .select([
          "j.tx_uuid as tx_uuid",
          "j.amount as amount",
          "j.currency as currency",
          "j.created_at as created_at",
          "counterparty_user.display_name as counterparty_name",
          "counterparty.rib as counterparty_rib",
          "t.reference as reference",
        ])
        .where("j.account_id", "=", accountId)
        .where("j.created_at", ">=", fromDate)
        .where("j.created_at", "<", toDateExclusive)
        .orderBy("j.created_at", "asc")
        .limit(STATEMENT_ROW_CAP)
        .execute(),
    ]);

    const openingBalance = openingRow?.total ?? 0n;
    const closingBalance = rangeRows.reduce((sum, r) => sum + r.amount, openingBalance);

    await recordAudit({ userId, action: "statement.request", resourceType: "account", resourceId: accountId, ip: request.ip });

    return reply.send({
      customer_id: customerId,
      display_name: account.display_name,
      rib: account.rib,
      currency: account.currency,
      from,
      to,
      opening_balance: openingBalance.toString(),
      closing_balance: closingBalance.toString(),
      transactions: rangeRows.map((r) => ({
        tx_uuid: r.tx_uuid,
        direction: r.amount < 0n ? "debit" : "credit",
        amount: (r.amount < 0n ? -r.amount : r.amount).toString(),
        currency: r.currency,
        counterparty_name: r.counterparty_name,
        counterparty_rib: r.counterparty_rib,
        reference: r.reference,
        created_at: r.created_at.toISOString(),
      })),
    });
  });
}
