import { isValidRib } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { config } from "../config.js";
import { db } from "../db/kysely.js";
import { transferTotal } from "../metrics.js";

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
  // app.rateLimit(...) as an explicit preHandler, placed AFTER
  // app.authenticate, rather than the config.rateLimit object style other
  // routes use (auth.ts, lookup.ts) -- this route's limit needs
  // request.user.aid, which only exists once authenticate has already run.
  // An explicit array gives certain ordering; config.rateLimit's own `hook`
  // option to reach the same effect relies on the plugin's onRoute-time
  // wiring interacting correctly with a separately-declared preHandler,
  // which is one more moving part than this needs. Closes D7 (CLAUDE.md
  // §11). Guarded by hasDecorator: buildApp({ rateLimit: false }) (every
  // existing test file, to avoid tripping the tight per-route limits during
  // rapid test requests) never registers the rate-limit plugin at all, so
  // app.rateLimit itself wouldn't exist to call.
  const transferPreHandlers = app.hasDecorator("rateLimit")
    ? [
        app.authenticate,
        app.rateLimit({
          max: config.rateLimitTransfersMax,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.user.aid,
        }),
      ]
    : [app.authenticate];

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
        // tx_uuid_conflict is a security tripwire (metrics.ts's own comment) --
        // its rate should be flat zero; a nonzero rate here means someone
        // attempted a settlement-slot hijack (CLAUDE.md §5), not a normal
        // failure a user just retried past.
        if (result.failureReason === "tx_uuid_conflict") {
          transferTotal.inc({ outcome: "tx_uuid_conflict" });
          return reply.status(409).send({ error: "TxUuidConflict", message: "tx_uuid is already in use by a different transaction" });
        }
        if (result.failureReason === "reservation_expired") {
          transferTotal.inc({ outcome: "reservation_expired" });
          return reply.status(409).send({ error: "ReservationExpired", message: result.failureReason });
        }
        transferTotal.inc({ outcome: "insufficient_funds" });
        return reply.status(409).send({ error: "InsufficientFunds", message: result.failureReason });
      }
      transferTotal.inc({ outcome: "settled" });

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
      .select([
        "j.tx_uuid as tx_uuid",
        "j.amount as amount",
        "j.currency as currency",
        "j.created_at as created_at",
        "counterparty.display_name as counterparty_name",
        "counterparty.rib as counterparty_rib",
        "t.reference as reference",
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
    });
  });
}
