import { formatMinorUnits, isValidRib } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { recordAudit } from "../audit/log.js";
import { config } from "../config.js";
import { withAccountAdvisoryLock } from "../db/advisoryLock.js";
import { db } from "../db/kysely.js";
import { notify } from "../notifications.js";
import { resolveOwnedAccount } from "./accountSelection.js";
import { sendSettlementFailure } from "./settlementRouteHelpers.js";
import { moneyRequestTotal } from "../metrics.js";

// Defensive cap, same pattern as notifications.ts's NOTIFICATIONS_LIST_CAP --
// this list has no pagination UI yet, so it's a ceiling, not a page size.
const MONEY_REQUESTS_LIST_CAP = 200;

// Same control-character guard as transfers.ts's referenceSchema.
const referenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(140)
  .refine((s) => ![...s].some((c) => c.charCodeAt(0) < 0x20), { message: "reference must not contain control characters" })
  .transform((s) => s.normalize("NFC"));

export const createMoneyRequestBodySchema = z
  .object({
    to_rib: z.string().optional(),
    to_beneficiary_id: z.string().uuid().optional(),
    amount: z.string().regex(/^\d+$/, "amount must be an integer minor-units string"),
    currency: z.string().length(3),
    reference: referenceSchema,
  })
  .refine((b) => Boolean(b.to_rib) !== Boolean(b.to_beneficiary_id), {
    message: "exactly one of to_rib or to_beneficiary_id must be provided",
  });

function serializeMoneyRequest(row: {
  id: string;
  requester_user_id: string;
  requester_name: string | null;
  requester_rib: string | null;
  target_user_id: string;
  target_name: string | null;
  target_rib: string | null;
  amount: bigint;
  currency: string;
  reference: string;
  status: string;
  tx_uuid: string | null;
  created_at: Date;
}) {
  return {
    id: row.id,
    requester: { display_name: row.requester_name, rib: row.requester_rib },
    target: { display_name: row.target_name, rib: row.target_rib },
    amount: row.amount.toString(),
    currency: row.currency,
    reference: row.reference,
    status: row.status,
    tx_uuid: row.tx_uuid,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Ship List v2 Wave 2 Phase 7: "request money" core. A request ALWAYS
 * names a specific target, resolved by RIB or beneficiary id at creation
 * time -- the exact same recipient-resolution shape `POST /transfers`
 * already uses, so "request money" reads as "send money," reversed. This
 * is a deliberate scope decision: an open-to-anyone QR/NFC broadcast
 * (like a merchant payment code, fulfillable by whoever scans it) is a
 * different feature with different authorization semantics, not what a
 * Venmo-style "request from a specific person" flow needs. QR/NFC here
 * (mobile/src/qr/profileQr.ts's RequestQrPayload) is a DELIVERY
 * mechanism for an already-targeted request -- scanning it just gets the
 * named target into Send faster, it doesn't change who's allowed to
 * fulfill it.
 *
 * Fulfilling reuses `bankAdapter.transfer()` completely unmodified -- a
 * fulfilled request is structurally an ordinary transfer with the
 * requester as recipient, so it inherits every ledger invariant
 * (CLAUDE.md §5) for free. **Known, accepted gap, stated plainly**: this
 * settlement path does NOT go through `POST /transfers`' own step-up
 * confirmation or rolling velocity-cap checks (Ship List v2 Wave 2 Phase
 * 4) -- those live in transfers.ts's route handler, not the adapter, and
 * extracting them into a shared, reusable form is real follow-up work,
 * not done this phase. A large or rapid-fire money-request fulfillment
 * is not yet covered by either fraud control. Tracked in
 * docs/SHIP_LIST_V2.md, not silently dropped.
 */
export function registerMoneyRequestRoutes(app: FastifyInstance): void {
  app.get("/money-requests", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: userId } = request.user;
    const rows = await db
      .selectFrom("money_requests as mr")
      .innerJoin("users as requester_user", "requester_user.user_id", "mr.requester_user_id")
      .innerJoin("accounts as requester_account", "requester_account.account_id", "mr.requester_account_id")
      .innerJoin("users as target_user", "target_user.user_id", "mr.target_user_id")
      .leftJoin("accounts as target_account", (join) =>
        join.onRef("target_account.user_id", "=", "mr.target_user_id").on("target_account.account_type", "=", "checking"),
      )
      .select([
        "mr.id as id",
        "mr.requester_user_id as requester_user_id",
        "requester_user.display_name as requester_name",
        "requester_account.rib as requester_rib",
        "mr.target_user_id as target_user_id",
        "target_user.display_name as target_name",
        "target_account.rib as target_rib",
        "mr.amount as amount",
        "mr.currency as currency",
        "mr.reference as reference",
        "mr.status as status",
        "mr.tx_uuid as tx_uuid",
        "mr.created_at as created_at",
      ])
      .where((eb) => eb.or([eb("mr.requester_user_id", "=", userId), eb("mr.target_user_id", "=", userId)]))
      .orderBy("mr.created_at", "desc")
      .limit(MONEY_REQUESTS_LIST_CAP)
      .execute();

    const incoming = rows.filter((r) => r.target_user_id === userId).map(serializeMoneyRequest);
    const outgoing = rows.filter((r) => r.requester_user_id === userId).map(serializeMoneyRequest);
    return reply.send({ incoming, outgoing });
  });

  app.post("/money-requests", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = createMoneyRequestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { to_rib, to_beneficiary_id, amount, currency, reference } = parsed.data;
    const { sub: userId } = request.user;

    const amountMinor = BigInt(amount);
    if (amountMinor <= 0n || amountMinor > config.maxTransferMinorUnits) {
      return reply.status(400).send({ error: "InvalidAmount", message: "amount must be positive and within the allowed limit" });
    }

    const requesterAccount = await resolveOwnedAccount(userId);
    if (!requesterAccount) {
      return reply.status(404).send({ error: "NotFound", message: "no such account" });
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
        return reply.status(404).send({ error: "UnknownBeneficiary", message: "beneficiary not found" });
      }
      resolvedRib = beneficiary.rib;
    } else {
      if (!isValidRib(to_rib!)) {
        return reply.status(400).send({ error: "InvalidRib", message: "to_rib is not a valid RIB" });
      }
      resolvedRib = to_rib!;
    }

    const target = await db.selectFrom("accounts").select(["user_id"]).where("rib", "=", resolvedRib).executeTakeFirst();
    if (!target) {
      return reply.status(404).send({ error: "UnknownRecipient", message: "no account with this RIB" });
    }
    if (target.user_id === userId) {
      return reply.status(400).send({ error: "SelfPayment", message: "cannot request money from yourself" });
    }

    const row = await db
      .insertInto("money_requests")
      .values({
        requester_user_id: userId,
        requester_account_id: requesterAccount.account_id,
        target_user_id: target.user_id,
        amount: amountMinor,
        currency,
        reference,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    await recordAudit({ userId, action: "money_request.create", resourceType: "money_request", resourceId: row.id, ip: request.ip });
    moneyRequestTotal.inc({ outcome: "created" });

    // Ship List v2 Wave 2 Phase 8: best-effort, never fails an
    // already-created request (notify()'s own doc comment has the full
    // reasoning, same posture as roundup.ts's maybeSweepRoundUp).
    try {
      await notify(target.user_id, "Money request", `${requesterAccount.display_name ?? "Someone"} is requesting ${formatMinorUnits(amountMinor)} ${currency} -- ${reference}`, {
        type: "money_request",
        request_id: row.id,
      });
    } catch (err) {
      request.log.error(err, "money-request notification failed (non-fatal, request already created)");
    }

    return reply.status(201).send({ id: row.id });
  });

  app.post("/money-requests/:id/fulfill", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "id must be a UUID" });
    }
    const { sub: userId } = request.user;

    const targetAccount = await resolveOwnedAccount(userId);
    if (!targetAccount) {
      return reply.status(404).send({ error: "NotFound", message: "no such account" });
    }

    // Ownership (only the NAMED target may fulfill -- a client-chosen id,
    // CLAUDE.md §10, never trusted bare) AND the settlement itself are
    // both done inside the SAME account-scoped advisory lock
    // (db/advisoryLock.ts's withAccountAdvisoryLock, the same primitive
    // Ship List v2 Wave 2 Phase 4 built for the velocity-cap check). An
    // earlier draft checked `status === "pending"` as an unlocked
    // pre-check, then settled with a freshly-randomized tx_uuid each
    // call -- bankAdapter.transfer()'s own tx_uuid-keyed idempotency
    // gives zero protection against two concurrent fulfill() calls each
    // using a DIFFERENT random tx_uuid, so both could pass the pending
    // check and both settle, double-debiting the target. Found and fixed
    // before shipping, not by /security-review after the fact this time
    // -- same bug shape, caught by recognizing the pattern directly.
    type FulfillOutcome =
      | { kind: "not_found" }
      | { kind: "not_pending"; status: string }
      | { kind: "settlement_failed"; result: Awaited<ReturnType<typeof bankAdapter.transfer>> }
      | {
          kind: "fulfilled";
          txUuid: string;
          settledAt: Date;
          requesterUserId: string;
          amount: bigint;
          currency: string;
          reference: string;
        };

    let outcome: FulfillOutcome;
    try {
      outcome = await withAccountAdvisoryLock(db, targetAccount.account_id, async (trx): Promise<FulfillOutcome> => {
        const moneyRequest = await trx
          .selectFrom("money_requests")
          .selectAll()
          .where("id", "=", id)
          .where("target_user_id", "=", userId)
          .executeTakeFirst();
        if (!moneyRequest) {
          return { kind: "not_found" };
        }
        if (moneyRequest.status !== "pending") {
          return { kind: "not_pending", status: moneyRequest.status };
        }

        const txUuid = randomUUID();
        const result = await bankAdapter.transfer(
          txUuid,
          targetAccount.account_id,
          moneyRequest.requester_account_id,
          moneyRequest.amount,
          moneyRequest.currency,
          { reference: moneyRequest.reference },
        );
        if (!result.success) {
          return { kind: "settlement_failed", result };
        }

        await trx.updateTable("money_requests").set({ status: "fulfilled", tx_uuid: txUuid }).where("id", "=", id).execute();
        return {
          kind: "fulfilled",
          txUuid,
          settledAt: result.settledAt,
          requesterUserId: moneyRequest.requester_user_id,
          amount: moneyRequest.amount,
          currency: moneyRequest.currency,
          reference: moneyRequest.reference,
        };
      });
    } catch (err) {
      // Postgres 55P03 (lock_not_available) -- same meaning and same fix
      // as transfers.ts's identical catch: this account is heavily
      // contended right now, so a clean 429 (try again shortly) is the
      // correct response, not a raw 500. The request never got its turn,
      // it didn't fail.
      if ((err as { code?: string }).code === "55P03") {
        moneyRequestTotal.inc({ outcome: "account_busy" });
        return reply.status(429).send({ error: "AccountBusy", message: "too many concurrent operations on this account -- try again shortly" });
      }
      throw err;
    }

    if (outcome.kind === "not_found") {
      return reply.status(404).send({ error: "NotFound", message: "money request not found" });
    }
    if (outcome.kind === "not_pending") {
      return reply.status(409).send({ error: "InvalidRequest", message: `this request is already ${outcome.status}` });
    }
    if (outcome.kind === "settlement_failed") {
      return sendSettlementFailure(reply, outcome.result, moneyRequestTotal);
    }

    await recordAudit({ userId, action: "money_request.fulfill", resourceType: "money_request", resourceId: id, ip: request.ip });
    moneyRequestTotal.inc({ outcome: "fulfilled" });

    try {
      await notify(
        outcome.requesterUserId,
        "Request paid",
        `${targetAccount.display_name ?? "Someone"} paid your request for ${formatMinorUnits(outcome.amount)} ${outcome.currency} -- ${outcome.reference}`,
        { type: "money_request_fulfilled", request_id: id, tx_uuid: outcome.txUuid },
      );
    } catch (err) {
      request.log.error(err, "money-request-fulfilled notification failed (non-fatal, settlement already succeeded)");
    }

    return reply.send({ tx_uuid: outcome.txUuid, settled_at: outcome.settledAt.toISOString() });
  });

  app.post("/money-requests/:id/decline", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "id must be a UUID" });
    }
    const { sub: userId } = request.user;

    const updated = await db
      .updateTable("money_requests")
      .set({ status: "declined" })
      .where("id", "=", id)
      .where("target_user_id", "=", userId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) {
      return reply.status(404).send({ error: "NotFound", message: "money request not found or already resolved" });
    }
    await recordAudit({ userId, action: "money_request.decline", resourceType: "money_request", resourceId: id, ip: request.ip });
    moneyRequestTotal.inc({ outcome: "declined" });

    return reply.status(204).send();
  });
}
