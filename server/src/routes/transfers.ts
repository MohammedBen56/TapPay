import { isValidRib } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { recordAudit } from "../audit/log.js";
import { config } from "../config.js";
import { db } from "../db/kysely.js";
import { transferTotal } from "../metrics.js";
import { accountScopedRateLimitedPreHandlers, sendSettlementFailure } from "./settlementRouteHelpers.js";

// Reject C0 control characters, NFC-normalize -- the reference is rendered
// directly in transaction history/receipts on both sides of a transfer.
const referenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(140)
  .refine((s) => ![...s].some((c) => c.charCodeAt(0) < 0x20), { message: "reference must not contain control characters" })
  .transform((s) => s.normalize("NFC"));

const transferBodySchema = z
  .object({
    tx_uuid: z.string().uuid(),
    to_rib: z.string().optional(),
    to_beneficiary_id: z.string().uuid().optional(),
    amount: z.string().regex(/^\d+$/, "amount must be an integer minor-units string"),
    currency: z.string().length(3),
    reference: referenceSchema,
  })
  .refine((b) => Boolean(b.to_rib) !== Boolean(b.to_beneficiary_id), {
    message: "exactly one of to_rib or to_beneficiary_id must be provided",
  });

export function registerTransferRoutes(app: FastifyInstance): void {
  // Closes D7 (CLAUDE.md §11) -- see settlementRouteHelpers.ts's own doc
  // comment for why this needs to be an explicit ordered array.
  const transferPreHandlers = accountScopedRateLimitedPreHandlers(app, config.rateLimitTransfersMax);

  app.post(
    "/transfers",
    { preHandler: transferPreHandlers },
    async (request, reply) => {
      const parsed = transferBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
      }
      const { tx_uuid, to_rib, to_beneficiary_id, amount, currency, reference } = parsed.data;
      const { aid: fromAccountId, sub: userId } = request.user;

      const amountMinor = BigInt(amount);
      if (amountMinor <= 0n || amountMinor > config.maxTransferMinorUnits) {
        return reply.status(400).send({ error: "InvalidAmount", message: "amount must be positive and within the allowed limit" });
      }
      if (!config.supportedCurrencies.includes(currency)) {
        return reply.status(400).send({ error: "InvalidCurrency", message: `unsupported currency: ${currency}` });
      }

      let resolvedRib: string;
      if (to_beneficiary_id) {
        const beneficiary = await db
          .selectFrom("beneficiaries")
          .select(["rib"])
          .where("id", "=", to_beneficiary_id)
          .where("owner_user_id", "=", userId)
          .executeTakeFirst();
        if (!beneficiary) {
          transferTotal.inc({ outcome: "unknown_beneficiary" });
          return reply.status(404).send({ error: "UnknownBeneficiary", message: "beneficiary not found" });
        }
        resolvedRib = beneficiary.rib;
      } else {
        if (!isValidRib(to_rib!)) {
          return reply.status(400).send({ error: "InvalidRib", message: "to_rib is not a valid RIB" });
        }
        resolvedRib = to_rib!;
      }

      const recipient = await db.selectFrom("accounts").select(["account_id"]).where("rib", "=", resolvedRib).executeTakeFirst();
      if (!recipient) {
        transferTotal.inc({ outcome: "unknown_rib" });
        return reply.status(404).send({ error: "UnknownRecipient", message: "no account with this RIB" });
      }
      // journal's UNIQUE (tx_uuid, account_id) makes a self-transfer structurally
      // impossible to double-journal (CLAUDE.md §5) -- reject explicitly here
      // rather than letting transfer() surface a raw constraint violation.
      if (recipient.account_id === fromAccountId) {
        transferTotal.inc({ outcome: "self_payment" });
        return reply.status(400).send({ error: "SelfPayment", message: "sender and recipient resolve to the same account" });
      }

      const result = await bankAdapter.transfer(tx_uuid, fromAccountId, recipient.account_id, amountMinor, currency, { reference });

      if (!result.success) {
        return sendSettlementFailure(reply, result, transferTotal);
      }
      transferTotal.inc({ outcome: "settled" });
      await recordAudit({ userId, action: "transfer.settle", resourceType: "transfer", resourceId: tx_uuid, ip: request.ip });

      const [balance, counterparty] = await Promise.all([
        bankAdapter.getAvailableBalance(fromAccountId, currency),
        db.selectFrom("accounts").select(["display_name", "rib"]).where("account_id", "=", recipient.account_id).executeTakeFirst(),
      ]);

      return reply.send({
        tx_uuid,
        settled_at: result.settledAt.toISOString(),
        amount,
        currency,
        reference,
        counterparty: counterparty ? { display_name: counterparty.display_name, rib: counterparty.rib } : null,
        balance_after: balance.toString(),
      });
    },
  );

  app.get("/transfers/:txUuid", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { txUuid } = request.params as { txUuid: string };
    if (!z.string().uuid().safeParse(txUuid).success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "txUuid must be a UUID" });
    }
    const { aid: accountId } = request.user;

    // Ownership is enforced structurally, not by a separate check: a row
    // only exists here if `j.account_id = accountId`, i.e. the caller's own
    // account actually participated in this tx_uuid.
    const row = await db
      .selectFrom("journal as j")
      .innerJoin("journal as o", (join) => join.onRef("o.tx_uuid", "=", "j.tx_uuid").on("o.account_id", "!=", accountId))
      .leftJoin("accounts as counterparty", "counterparty.account_id", "o.account_id")
      .leftJoin("transfers as t", "t.tx_uuid", "j.tx_uuid")
      .leftJoin("billers as bl", "bl.account_id", "o.account_id")
      .select([
        "j.tx_uuid as tx_uuid",
        "j.amount as amount",
        "j.currency as currency",
        "j.created_at as created_at",
        "counterparty.display_name as counterparty_name",
        "counterparty.rib as counterparty_rib",
        "t.reference as reference",
        "bl.category as biller_category",
      ])
      .where("j.account_id", "=", accountId)
      .where("j.tx_uuid", "=", txUuid)
      .executeTakeFirst();

    if (!row) {
      return reply.status(404).send({ error: "NotFound", message: "no transaction with this tx_uuid for your account" });
    }

    return reply.send({
      tx_uuid: row.tx_uuid,
      direction: row.amount < 0n ? "debit" : "credit",
      amount: (row.amount < 0n ? -row.amount : row.amount).toString(),
      currency: row.currency,
      counterparty_name: row.counterparty_name,
      counterparty_rib: row.counterparty_rib,
      reference: row.reference,
      created_at: row.created_at.toISOString(),
      is_biller: row.biller_category !== null,
      biller_category: row.biller_category,
    });
  });
}
