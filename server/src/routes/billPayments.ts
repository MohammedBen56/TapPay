import type { BillerCategory } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { recordAudit } from "../audit/log.js";
import { config } from "../config.js";
import { db } from "../db/kysely.js";
import { billPaymentTotal } from "../metrics.js";
import { createCursorCodec } from "./cursor.js";
import { accountScopedRateLimitedPreHandlers, sendSettlementFailure } from "./settlementRouteHelpers.js";

const CATEGORY_LABELS: Record<BillerCategory, string> = {
  electricity: "Electricity",
  water: "Water",
  internet: "Internet",
};

function composeReference(category: BillerCategory, billerName: string, subscriberReference: string): string {
  return `${CATEGORY_LABELS[category]} — ${billerName} (${subscriberReference})`;
}

// Same control-character guard as transfers.ts's referenceSchema -- this
// value is rendered directly in receipts/history too. Shorter max (64, not
// 140): a contract/meter/subscriber number, not a free-text note.
const subscriberReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((s) => ![...s].some((c) => c.charCodeAt(0) < 0x20), { message: "subscriber_reference must not contain control characters" })
  .transform((s) => s.normalize("NFC"));

const categoryQuerySchema = z.enum(["electricity", "water", "internet"]).optional();

const payBillBodySchema = z.object({
  tx_uuid: z.string().uuid(),
  biller_id: z.string().uuid(),
  subscriber_reference: subscriberReferenceSchema,
  amount: z.string().regex(/^\d+$/, "amount must be an integer minor-units string"),
  currency: z.string().length(3),
});

const billPaymentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().optional(),
});

// Tie-broken on tx_uuid (already the primary key here) instead of a bigint
// id -- bill_payments has no autoincrement column of its own, and a UUID
// is just as valid a deterministic tiebreaker for keyset pagination as a
// bigint is.
const cursorCodec = createCursorCodec<string>(
  (txUuid) => txUuid,
  (s) => s,
);

/** Pay bills (electricity/water/internet) against a mock biller catalog
 * (018_billers.cjs). A biller is just another `accounts` row, so settlement
 * reuses bankAdapter.transfer() unmodified -- see the migration's own
 * comment. bill_payments (019_bill_payments.cjs) is a structured,
 * best-effort second record written only after a successful settlement, so
 * the money movement itself is always correct even if this route's second
 * insert never runs (a client retry with the same tx_uuid is safe/
 * idempotent and would fill it in). */
export function registerBillPaymentRoutes(app: FastifyInstance): void {
  app.get("/billers", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsedQuery = categoryQuerySchema.safeParse((request.query as { category?: string }).category);
    if (!parsedQuery.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsedQuery.error.message });
    }

    let query = db.selectFrom("billers").select(["id", "name", "category"]).where("is_active", "=", true).orderBy("name");
    if (parsedQuery.data) {
      query = query.where("category", "=", parsedQuery.data);
    }
    const billers = await query.execute();
    return reply.send({ billers });
  });

  const payBillPreHandlers = accountScopedRateLimitedPreHandlers(app, config.rateLimitBillPaymentsMax);

  app.post("/bill-payments", { preHandler: payBillPreHandlers }, async (request, reply) => {
    const parsed = payBillBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { tx_uuid, biller_id, subscriber_reference, amount, currency } = parsed.data;
    const { aid: fromAccountId, sub: userId } = request.user;

    const amountMinor = BigInt(amount);
    if (amountMinor <= 0n || amountMinor > config.maxTransferMinorUnits) {
      return reply.status(400).send({ error: "InvalidAmount", message: "amount must be positive and within the allowed limit" });
    }
    if (!config.supportedCurrencies.includes(currency)) {
      return reply.status(400).send({ error: "InvalidCurrency", message: `unsupported currency: ${currency}` });
    }

    const biller = await db
      .selectFrom("billers")
      .select(["id", "name", "category", "account_id"])
      .where("id", "=", biller_id)
      .where("is_active", "=", true)
      .executeTakeFirst();
    if (!biller) {
      billPaymentTotal.inc({ outcome: "unknown_biller" });
      return reply.status(404).send({ error: "UnknownBiller", message: "biller not found" });
    }

    const reference = composeReference(biller.category, biller.name, subscriber_reference);
    const result = await bankAdapter.transfer(tx_uuid, fromAccountId, biller.account_id, amountMinor, currency, { reference });

    if (!result.success) {
      return sendSettlementFailure(reply, result, billPaymentTotal);
    }
    billPaymentTotal.inc({ outcome: "settled" });
    await recordAudit({ userId, action: "bill_payment.settle", resourceType: "bill_payment", resourceId: tx_uuid, ip: request.ip });

    const [, balance] = await Promise.all([
      db
        .insertInto("bill_payments")
        .values({ tx_uuid, account_id: fromAccountId, biller_id: biller.id, subscriber_reference })
        .onConflict((oc) => oc.column("tx_uuid").doNothing())
        .execute(),
      bankAdapter.getAvailableBalance(fromAccountId, currency),
    ]);

    return reply.send({
      tx_uuid,
      settled_at: result.settledAt.toISOString(),
      biller: { id: biller.id, name: biller.name, category: biller.category },
      subscriber_reference,
      amount,
      currency,
      reference,
      balance_after: balance.toString(),
    });
  });

  app.get("/bill-payments", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { aid: accountId } = request.user;
    const parsed = billPaymentsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { limit, before } = parsed.data;

    let cursor: { createdAt: Date; tiebreak: string } | null = null;
    if (before !== undefined) {
      cursor = cursorCodec.decode(before);
      if (!cursor) {
        return reply.status(400).send({ error: "InvalidRequest", message: "malformed cursor" });
      }
    }

    let query = db
      .selectFrom("bill_payments as bp")
      .innerJoin("billers as b", "b.id", "bp.biller_id")
      .innerJoin("transfers as t", "t.tx_uuid", "bp.tx_uuid")
      .select([
        "bp.tx_uuid as tx_uuid",
        "bp.subscriber_reference as subscriber_reference",
        "bp.created_at as created_at",
        "b.id as biller_id",
        "b.name as biller_name",
        "b.category as biller_category",
        "t.amount as amount",
        "t.currency as currency",
        "t.reference as reference",
      ])
      .where("bp.account_id", "=", accountId)
      .orderBy("bp.created_at", "desc")
      .orderBy("bp.tx_uuid", "desc")
      .limit(limit + 1);

    if (cursor) {
      const { createdAt, tiebreak: txUuid } = cursor;
      query = query.where((eb) =>
        eb.or([eb("bp.created_at", "<", createdAt), eb.and([eb("bp.created_at", "=", createdAt), eb("bp.tx_uuid", "<", txUuid)])]),
      );
    }

    const rows = await query.execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return reply.send({
      bill_payments: page.map((r) => ({
        tx_uuid: r.tx_uuid,
        biller: { id: r.biller_id, name: r.biller_name, category: r.biller_category },
        subscriber_reference: r.subscriber_reference,
        amount: r.amount.toString(),
        currency: r.currency,
        reference: r.reference,
        created_at: r.created_at.toISOString(),
      })),
      next_cursor: hasMore && last ? cursorCodec.encode(last.created_at, last.tx_uuid) : null,
    });
  });

  app.get("/bill-payments/:txUuid", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { txUuid } = request.params as { txUuid: string };
    if (!z.string().uuid().safeParse(txUuid).success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "txUuid must be a UUID" });
    }
    const { aid: accountId } = request.user;

    const row = await db
      .selectFrom("bill_payments as bp")
      .innerJoin("billers as b", "b.id", "bp.biller_id")
      .innerJoin("transfers as t", "t.tx_uuid", "bp.tx_uuid")
      .select([
        "bp.tx_uuid as tx_uuid",
        "bp.subscriber_reference as subscriber_reference",
        "bp.created_at as created_at",
        "b.id as biller_id",
        "b.name as biller_name",
        "b.category as biller_category",
        "t.amount as amount",
        "t.currency as currency",
        "t.reference as reference",
      ])
      .where("bp.account_id", "=", accountId)
      .where("bp.tx_uuid", "=", txUuid)
      .executeTakeFirst();

    if (!row) {
      return reply.status(404).send({ error: "NotFound", message: "no bill payment with this tx_uuid for your account" });
    }

    return reply.send({
      tx_uuid: row.tx_uuid,
      biller: { id: row.biller_id, name: row.biller_name, category: row.biller_category },
      subscriber_reference: row.subscriber_reference,
      amount: row.amount.toString(),
      currency: row.currency,
      reference: row.reference,
      created_at: row.created_at.toISOString(),
    });
  });
}
