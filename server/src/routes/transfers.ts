import { isValidRib } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { recordAudit } from "../audit/log.js";
import type { AccessTokenPayload } from "../auth/plugin.js";
import { config } from "../config.js";
import { withAccountAdvisoryLock } from "../db/advisoryLock.js";
import { db } from "../db/kysely.js";
import { transferTotal } from "../metrics.js";
import { maybeSweepRoundUp } from "../roundup.js";
import { resolveOwnedAccount } from "./accountSelection.js";
import { accountScopedRateLimitedPreHandlers, echoIdempotencyKey, sendSettlementFailure } from "./settlementRouteHelpers.js";

/** Ship List v2 Wave 2 Phase 4. `app.jwt.verify` (distinct from
 * `request.jwtVerify()`) operates on a bare token string, which is exactly
 * what's needed here -- the step-up token travels in the request BODY
 * (`step_up_token`), not the Authorization header `app.authenticate`
 * already consumed for the caller's real access token. Fails closed: any
 * missing/expired/malformed/wrong-user/wrong-type/wrong-tx_uuid token
 * returns false, no exception ever escapes to the caller.
 *
 * Checks `payload.tx_uuid === txUuid` -- found by /security-review as a
 * real gap in an earlier draft that checked only `typ`/`sub`: without
 * binding to the specific transfer, one password re-entry stays valid for
 * the token's whole TTL and could be replayed across many separate large
 * transfers. Re-presenting the SAME step-up token for a resubmission of
 * the SAME tx_uuid still passes here, which is correct: that resubmission
 * is a legitimate idempotent replay (CLAUDE.md §5), not a new debit.
 *
 * MUST be awaited even though @fastify/jwt's own types show a synchronous
 * `Decoded` return -- this app's secret resolver (auth/plugin.ts's
 * resolveSecret) is async, and fast-jwt silently returns a *Promise*
 * instead of the payload when the resolver is async, rather than throwing
 * or widening its declared return type. A first draft of this function
 * read `payload.typ` off that Promise directly (always `undefined`, never
 * a thrown error) -- every step-up token silently failed verification.
 * Caught by a live curl test, not by the type checker. */
async function verifyStepUpToken(app: FastifyInstance, token: string | undefined, userId: string, txUuid: string): Promise<boolean> {
  if (!token) return false;
  try {
    const payload = await app.jwt.verify<AccessTokenPayload>(token);
    return payload.typ === "step_up" && payload.sub === userId && payload.tx_uuid === txUuid;
  } catch {
    return false;
  }
}

// Reject C0 control characters, NFC-normalize -- the reference is rendered
// directly in transaction history/receipts on both sides of a transfer.
const referenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(140)
  .refine((s) => ![...s].some((c) => c.charCodeAt(0) < 0x20), { message: "reference must not contain control characters" })
  .transform((s) => s.normalize("NFC"));

export const transferBodySchema = z
  .object({
    tx_uuid: z.string().uuid(),
    to_rib: z.string().optional(),
    to_beneficiary_id: z.string().uuid().optional(),
    amount: z.string().regex(/^\d+$/, "amount must be an integer minor-units string"),
    currency: z.string().length(3),
    reference: referenceSchema,
    // Ship List v2 Phase 8: which of the caller's own accounts sends the
    // money -- ownership-checked via accountSelection.ts, defaults to
    // checking. This is what lets money move OUT of savings.
    from_account_id: z.string().uuid().optional(),
    // Ship List v2 Wave 2 Phase 4: required only once amount reaches
    // config.stepUpThresholdMinorUnits -- see POST /auth/step-up.
    step_up_token: z.string().optional(),
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
      const { tx_uuid, to_rib, to_beneficiary_id, amount, currency, reference, from_account_id, step_up_token } = parsed.data;
      const { sub: userId } = request.user;

      const amountMinor = BigInt(amount);
      if (amountMinor <= 0n || amountMinor > config.maxTransferMinorUnits) {
        return reply.status(400).send({ error: "InvalidAmount", message: "amount must be positive and within the allowed limit" });
      }
      if (!config.supportedCurrencies.includes(currency)) {
        return reply.status(400).send({ error: "InvalidCurrency", message: `unsupported currency: ${currency}` });
      }

      const fromAccount = await resolveOwnedAccount(userId, from_account_id);
      if (!fromAccount) {
        return reply.status(404).send({ error: "NotFound", message: "no such account" });
      }
      const fromAccountId = fromAccount.account_id;

      // Ship List v2 Wave 2 Phase 4: step-up confirmation. Fail fast,
      // before any recipient resolution or DB writes -- an over-threshold
      // transfer with no/invalid/wrong-tx_uuid step_up_token never gets far
      // enough to touch the ledger. No race to worry about here (unlike the
      // velocity cap below): this is a pure signature/claims check against
      // this ONE request's own tx_uuid, not a read-then-write over shared
      // account state.
      if (amountMinor >= config.stepUpThresholdMinorUnits && !(await verifyStepUpToken(app, step_up_token, userId, tx_uuid))) {
        transferTotal.inc({ outcome: "step_up_required" });
        await recordAudit({ userId, action: "transfer.step_up_required", resourceType: "transfer", resourceId: tx_uuid, ip: request.ip });
        return reply.status(403).send({
          error: "StepUpRequired",
          message: "this amount requires a fresh step_up_token bound to this tx_uuid -- call POST /auth/step-up first",
        });
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

      // Ship List v2 Wave 2 Phase 4: rolling 24h velocity cap, enforced
      // atomically with the settlement itself. journal is shared by both
      // settlement surfaces (P2P transfers AND bill payments both write
      // through bankAdapter.transfer()), so this SUM bounds total outbound
      // damage across both, not just /transfers in isolation -- see
      // config.ts's dailyVelocityCapMinorUnits doc comment.
      //
      // The SUM check and the settlement call are wrapped in the SAME
      // account-scoped advisory lock (db/advisoryLock.ts's
      // withAccountAdvisoryLock) specifically so concurrent requests on
      // this account can't each read the SUM before any of them has
      // committed a new debit -- found by /security-review as a real,
      // concretely exploitable TOCTOU bypass in an earlier draft that ran
      // this SUM as an unlocked pre-check.
      let settleOutcome: { kind: "velocity_cap_exceeded" } | { kind: "settled"; result: Awaited<ReturnType<typeof bankAdapter.transfer>> };
      try {
        settleOutcome = await withAccountAdvisoryLock(db, fromAccountId, async (trx) => {
          const velocityRow = await trx
            .selectFrom("journal")
            .select((eb) => eb.fn.sum<bigint>("amount").as("total_debited"))
            .where("account_id", "=", fromAccountId)
            .where("amount", "<", 0n)
            .where("created_at", ">=", new Date(Date.now() - 24 * 60 * 60 * 1000))
            .executeTakeFirst();
          const alreadyDebited24h = velocityRow?.total_debited ? -velocityRow.total_debited : 0n;
          if (alreadyDebited24h + amountMinor > config.dailyVelocityCapMinorUnits) {
            return { kind: "velocity_cap_exceeded" as const };
          }
          const result = await bankAdapter.transfer(tx_uuid, fromAccountId, recipient.account_id, amountMinor, currency, { reference });
          return { kind: "settled" as const, result };
        });
      } catch (err) {
        // Postgres 55P03 (lock_not_available): this account is heavily
        // contended right now -- withAccountAdvisoryLock's blocking wait
        // can exceed dbLockTimeoutMs under a burst of concurrent requests
        // on the SAME account. A real, honest 429 (try again shortly) is
        // the correct response here, not a raw 500 -- the transfer simply
        // never got its turn, it didn't fail.
        if ((err as { code?: string }).code === "55P03") {
          transferTotal.inc({ outcome: "account_busy" });
          return reply.status(429).send({ error: "AccountBusy", message: "too many concurrent operations on this account -- try again shortly" });
        }
        throw err;
      }

      if (settleOutcome.kind === "velocity_cap_exceeded") {
        transferTotal.inc({ outcome: "velocity_cap_exceeded" });
        await recordAudit({ userId, action: "transfer.velocity_cap_exceeded", resourceType: "transfer", resourceId: tx_uuid, ip: request.ip });
        return reply.status(429).send({
          error: "VelocityCapExceeded",
          message: "this account's rolling 24h outbound transfer limit has been reached -- try again later",
        });
      }
      const { result } = settleOutcome;

      if (!result.success) {
        return sendSettlementFailure(reply, result, transferTotal);
      }
      transferTotal.inc({ outcome: "settled" });
      await recordAudit({ userId, action: "transfer.settle", resourceType: "transfer", resourceId: tx_uuid, ip: request.ip });
      echoIdempotencyKey(request, reply, tx_uuid);

      // Ship List v2 Wave 2 Phase 5: opt-in round-up savings -- best-effort,
      // never lets a sweep failure fail this already-successful transfer's
      // own response (roundup.ts's own doc comment has the full reasoning).
      try {
        await maybeSweepRoundUp({ userId, fromAccountId, originalTxUuid: tx_uuid, debitedAmount: amountMinor, currency });
      } catch (err) {
        request.log.error(err, "round-up sweep failed (non-fatal, original transfer already settled)");
      }

      const [balance, counterparty] = await Promise.all([
        bankAdapter.getAvailableBalance(fromAccountId, currency),
        db
          .selectFrom("accounts")
          .innerJoin("users", "users.user_id", "accounts.user_id")
          .select(["users.display_name as display_name", "accounts.rib as rib"])
          .where("accounts.account_id", "=", recipient.account_id)
          .executeTakeFirst(),
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
    const { sub: userId } = request.user;

    // Ownership is enforced structurally, not by a separate check: a row
    // only exists here if `j.account_id` is one of the CALLER'S OWN accounts
    // (Ship List v2 Phase 8: any of them, checking or savings -- not just
    // the JWT's default `aid` -- otherwise a receipt for a settlement that
    // happened on savings would 404 for its own owner).
    const row = await db
      .selectFrom("journal as j")
      .innerJoin("accounts as own", (join) => join.onRef("own.account_id", "=", "j.account_id").on("own.user_id", "=", userId))
      .innerJoin("journal as o", (join) => join.onRef("o.tx_uuid", "=", "j.tx_uuid").onRef("o.account_id", "!=", "j.account_id"))
      .leftJoin("accounts as counterparty", "counterparty.account_id", "o.account_id")
      .leftJoin("users as counterparty_user", "counterparty_user.user_id", "counterparty.user_id")
      .leftJoin("transfers as t", "t.tx_uuid", "j.tx_uuid")
      .leftJoin("billers as bl", "bl.account_id", "o.account_id")
      .select([
        "j.tx_uuid as tx_uuid",
        "j.amount as amount",
        "j.currency as currency",
        "j.created_at as created_at",
        "counterparty_user.display_name as counterparty_name",
        "counterparty.rib as counterparty_rib",
        "t.reference as reference",
        "bl.category as biller_category",
      ])
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
