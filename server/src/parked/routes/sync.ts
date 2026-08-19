import {
  bytesToUuid,
  decodeCoseSign1Unverified,
  decodeFreshnessToken,
  decodeOfflineIou,
  uuidToBytes,
  verifyCoseSign1,
} from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import { bankAdapter } from "../../adapters/index.js";
import { config } from "../../config.js";
import { serverPublicKeyBytes } from "../../crypto/serverSigner.js";
import { db, type Database, type OfflineIntentStatus } from "../../db/kysely.js";
import { lockDevice } from "../../db/locking.js";
import { findDeviceAccount } from "./deviceLookup.js";

const syncBodySchema = z.object({
  device_id: z.string().uuid(),
  // Unbounded before this cap, one request could force unlimited ECDSA
  // verifications and DB transactions -- config over constants (CLAUDE.md §8).
  intents: z
    .array(
      z.object({
        cose_iou: z.string(), // base64
        freshness_token: z.string(), // base64
      }),
    )
    .max(config.syncMaxIntentsPerBatch),
});

/** Outcomes that can never be persisted to offline_intents (no trusted
 * tx_uuid, the FK on receiver_id can't be satisfied, or the request never
 * gets far enough to admit) -- response-only, never written to the DB, unlike
 * the six OfflineIntentStatus values which are. */
type SyncResultStatus =
  | OfflineIntentStatus
  | "FAILED_INVALID_SIGNATURE"
  | "FAILED_UNKNOWN_RECIPIENT"
  | "FAILED_SELF_PAYMENT"
  | "FAILED_INVALID_AMOUNT";

interface SyncResult {
  tx_uuid: string | null;
  status: SyncResultStatus;
  settled_at?: string;
  receipt?: string;
}

async function resultFromExistingRow(
  conn: Kysely<Database>,
  row: { tx_uuid: string; status: OfflineIntentStatus },
): Promise<SyncResult> {
  if (row.status !== "SETTLED") {
    return { tx_uuid: row.tx_uuid, status: row.status };
  }
  // offline_intents doesn't duplicate receipt/settled_at -- transfer() already
  // wrote them onto the reservations row keyed by the same tx_uuid; read from
  // there rather than storing the same fact twice.
  const reservation = await conn
    .selectFrom("reservations")
    .select(["settled_at", "receipt_signature"])
    .where("tx_uuid", "=", row.tx_uuid)
    .executeTakeFirst();
  return {
    tx_uuid: row.tx_uuid,
    status: "SETTLED",
    settled_at: reservation?.settled_at?.toISOString(),
    receipt: reservation?.receipt_signature ? Buffer.from(reservation.receipt_signature).toString("base64") : undefined,
  };
}

export function registerSyncRoutes(app: FastifyInstance): void {
  app.post(
    "/tx/sync",
    { config: { rateLimit: { max: config.rateLimitTxSyncMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = syncBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
      }
      const { device_id, intents } = parsed.data;
      const deviceIdBytes = Buffer.from(uuidToBytes(device_id));

      // Pre-decode every intent up front. A malformed intent (bad base64, wrong
      // CBOR shape, or a sender_device_id that doesn't match the batch's own
      // device_id) is a client bug, not a per-intent business outcome -- it fails
      // the whole request, same posture as /tx/submit's InvalidRequest response,
      // rather than silently producing a partial batch result.
      const decodedIntents: { iouBytes: Uint8Array; tokenBytes: Uint8Array }[] = [];
      for (const intent of intents) {
        try {
          const iouBytes = new Uint8Array(Buffer.from(intent.cose_iou, "base64"));
          const tokenBytes = new Uint8Array(Buffer.from(intent.freshness_token, "base64"));
          const unverified = decodeCoseSign1Unverified(iouBytes);
          const claimedSender = decodeOfflineIou(unverified.payload).sender_device_id;
          if (bytesToUuid(claimedSender) !== device_id) {
            throw new Error("sender_device_id does not match the batch's device_id");
          }
          decodedIntents.push({ iouBytes, tokenBytes });
        } catch {
          return reply.status(400).send({
            error: "InvalidRequest",
            message: "malformed COSE_Sign1 / OfflineIou, or sender_device_id mismatch, in one of the intents",
          });
        }
      }

      const senderLookup = await findDeviceAccount(deviceIdBytes);
      if (!senderLookup) {
        return reply.status(404).send({ error: "UnknownSender", message: "sender device is not enrolled" });
      }
      if (!senderLookup.device.attestation_ok) {
        return reply.status(403).send({ error: "UnverifiedDevice", message: "sender device attestation was not verified" });
      }

      const results: SyncResult[] = [];
      for (const { iouBytes, tokenBytes } of decodedIntents) {
        results.push(await processOneIntent(deviceIdBytes, device_id, senderLookup, iouBytes, tokenBytes));
      }

      return reply.send({ results });
    },
  );
}

async function processOneIntent(
  deviceIdBytes: Buffer,
  deviceId: string,
  senderLookup: NonNullable<Awaited<ReturnType<typeof findDeviceAccount>>>,
  iouBytes: Uint8Array,
  tokenBytes: Uint8Array,
): Promise<SyncResult> {
  const verified = verifyCoseSign1(iouBytes, new Uint8Array(senderLookup.device.identity_pubkey));
  if (!verified) {
    // No trusted tx_uuid to key a durable row on -- this outcome is reported,
    // never persisted, and never advances last_seq (never proven genuine).
    return { tx_uuid: null, status: "FAILED_INVALID_SIGNATURE" };
  }
  const iou = decodeOfflineIou(verified.payload);
  // decodeOfflineIou only checks CBOR array arity, not field byte-lengths --
  // the batch-level pre-decode loop validates sender_device_id this same way
  // but doesn't reach tx_uuid, so a validly-signed IOU with a malformed
  // tx_uuid would otherwise throw here uncaught (500, sanitized but still not
  // a clean typed per-intent outcome).
  let txUuid: string;
  try {
    txUuid = bytesToUuid(iou.tx_uuid);
  } catch {
    return { tx_uuid: null, status: "FAILED_INVALID_SIGNATURE" };
  }

  // Idempotency, same invariant /tx/submit's transfer() already gives Mode
  // A/B: an already-terminal tx_uuid returns its recorded outcome untouched.
  // A PENDING row means an earlier attempt was admitted (sequence + freshness
  // already checked and last_seq already advanced) but crashed before
  // settling -- resume straight at settlement below, don't redo admission.
  const existingRow = await db
    .selectFrom("offline_intents")
    .select(["tx_uuid", "status", "cose_proposal"])
    .where("tx_uuid", "=", txUuid)
    .executeTakeFirst();
  if (existingRow) {
    // tx_uuid is chosen by whoever signs a message -- it is NOT scoped to a
    // device. Without this check, a different device could submit its own
    // self-signed IOU that happens to reuse another device's in-flight (or
    // already-settled) tx_uuid: since neither the PENDING-resume path nor the
    // terminal-idempotency path below re-validates who is asking, that second
    // signer's transfer() call would silently execute (or the terminal path
    // would hand back someone else's receipt) under the original tx_uuid,
    // hijacking the settlement slot. Resuming or replaying an existing row
    // must be the exact same signed bytes that created it -- found and fixed
    // via /security-review, see server/src/routes/__tests__/sync.test.ts.
    if (!Buffer.from(iouBytes).equals(existingRow.cose_proposal)) {
      return { tx_uuid: txUuid, status: "FAILED_INVALID_SIGNATURE" };
    }
    if (existingRow.status !== "PENDING") {
      return resultFromExistingRow(db, existingRow);
    }
  }

  const recipientLookup = await findDeviceAccount(Buffer.from(iou.recipient_device_id));
  if (!recipientLookup) {
    // Can't insert offline_intents (receiver_id is NOT NULL / FK'd) -- reported
    // as a transient failure, not a durable audit fact. Not expected in
    // practice: the recipient's request QR is what carries this device_id, so
    // it should already be enrolled by construction.
    return { tx_uuid: txUuid, status: "FAILED_UNKNOWN_RECIPIENT" };
  }

  if (senderLookup.account.account_id === recipientLookup.account.account_id) {
    // Same guard as /tx/submit: journal's UNIQUE (tx_uuid, account_id) makes a
    // self-transfer structurally impossible to double-journal. Reported, never
    // persisted -- same posture as FAILED_UNKNOWN_RECIPIENT above, since no
    // admission row should be created for a request that can never settle.
    return { tx_uuid: txUuid, status: "FAILED_SELF_PAYMENT" };
  }

  if (iou.amount <= 0n || iou.amount > config.maxTransferMinorUnits || !config.supportedCurrencies.includes(iou.currency)) {
    // Same guard as /tx/submit's InvalidAmount/InvalidCurrency, just as a
    // per-intent response status instead of a whole-batch 400 -- one bad
    // amount shouldn't fail every other intent in the batch. Reported, never
    // persisted, same posture as FAILED_UNKNOWN_RECIPIENT/FAILED_SELF_PAYMENT
    // above: without this, a non-positive amount reaches the DB's
    // `CHECK (amount > 0)` and surfaces as an untyped 500 mid-batch, after
    // admission (and last_seq) has already advanced for earlier intents.
    return { tx_uuid: txUuid, status: "FAILED_INVALID_AMOUNT" };
  }

  if (!existingRow) {
    // Admission: lock the device, insert the PENDING audit row, check
    // sequence + freshness, and (if both pass) advance last_seq -- all in one
    // short transaction that COMMITS before bankAdapter.transfer() is ever
    // called. This must never wrap the transfer() call: inserting into
    // offline_intents takes an implicit FK-check lock on the referenced
    // accounts row, which would otherwise still be held (transaction open)
    // while transfer()'s own separate transaction tries to SELECT ... FOR
    // UPDATE that exact row -- two different open transactions each waiting
    // on the other's commit, forever. Keeping admission and settlement as two
    // separate, sequential transactions (rather than one nested inside the
    // other) is what avoids that deadlock.
    const admissionResult = await db.transaction().execute(async (trx) => {
      await lockDevice(trx, deviceIdBytes);
      await trx
        .insertInto("offline_intents")
        .values({
          tx_uuid: txUuid,
          sender_id: senderLookup.device.user_id,
          receiver_id: recipientLookup.device.user_id,
          amount: iou.amount,
          currency: iou.currency,
          cose_proposal: Buffer.from(iouBytes),
          status: "PENDING",
        })
        .onConflict((oc) => oc.column("tx_uuid").doNothing())
        .execute();

      // Re-read fresh under the lock just taken -- last_seq may have advanced
      // from an earlier intent processed earlier in this very batch. Strict
      // increase required (ADV-03: a replayed/rolled-back seq must never pass
      // this a second time).
      const deviceRow = await trx
        .selectFrom("devices")
        .select(["last_seq", "rollback_flagged_at"])
        .where("device_id", "=", deviceIdBytes)
        .executeTakeFirstOrThrow();

      if (iou.seq <= deviceRow.last_seq) {
        if (!deviceRow.rollback_flagged_at) {
          await trx.updateTable("devices").set({ rollback_flagged_at: new Date() }).where("device_id", "=", deviceIdBytes).execute();
        }
        await trx.updateTable("offline_intents").set({ status: "FAILED_SEQUENCE_REGRESSION" }).where("tx_uuid", "=", txUuid).execute();
        return "FAILED_SEQUENCE_REGRESSION" as const;
      }

      // Freshness check: the token must be a genuine, unexpired server
      // attestation of THIS device's recency, not a client claim. A failing
      // token still consumes this seq slot below -- the signed message was
      // genuinely this device's, only a *replayed* seq should be rejected
      // without consuming it (see gap #4 in the M2 plan).
      const tokenVerified = verifyCoseSign1(tokenBytes, serverPublicKeyBytes);
      const token = tokenVerified ? decodeFreshnessToken(tokenVerified.payload) : null;
      const freshnessOk =
        token !== null &&
        bytesToUuid(token.device_id) === deviceId &&
        iou.ts >= token.issued_at &&
        iou.ts - token.issued_at <= config.offlineFreshnessTokenTtlMs;

      // last_seq advances regardless of freshness/settlement outcome from
      // here on: the seq slot is consumed once a genuinely-signed, on-time-
      // in-sequence message was processed, not only when it happens to settle
      // (see gap #4).
      await trx.updateTable("devices").set({ last_seq: iou.seq }).where("device_id", "=", deviceIdBytes).execute();

      if (!freshnessOk) {
        await trx.updateTable("offline_intents").set({ status: "FAILED_EXPIRED" }).where("tx_uuid", "=", txUuid).execute();
        return "FAILED_EXPIRED" as const;
      }
      return null;
    });

    if (admissionResult) {
      return { tx_uuid: txUuid, status: admissionResult };
    }
  }

  // Settle via the SAME transfer() /tx/submit already calls -- Mode C
  // settlement is the identical ledger operation as Mode A/B, just invoked
  // later, from here instead of /tx/submit. No IBankAdapter changes needed.
  // Runs in its own transaction (inside transfer() itself), started only
  // after admission's transaction has already committed.
  //
  // Wrapped in try/catch: admission has already committed by this point (the
  // offline_intents row is PENDING and last_seq has already advanced), so a
  // thrown bank fault here must not become an unhandled 500 that aborts the
  // rest of the batch. Leave the row PENDING (never a FAILED_* status this
  // device didn't actually earn) -- the client's normal resubmission of the
  // byte-identical intent on its next sync will retry settlement and either
  // succeed or fail for a real reason.
  let result;
  try {
    result = await bankAdapter.transfer(
      txUuid,
      senderLookup.account.account_id,
      recipientLookup.account.account_id,
      iou.amount,
      iou.currency,
      // OfflineIou has no nonce concept (unlike TxProposal) -- all-zero, per
      // TxReceipt's doc comment. The recipient_device_id binding alone is Mode
      // C's protection; a residual replay of a genuinely-settled payment to
      // this SAME payee is caught separately by incoming_intents' tx_uuid
      // PRIMARY KEY on the mobile side.
      { recipientDeviceId: iou.recipient_device_id, receiverNonce: new Uint8Array(16) },
    );
  } catch {
    return { tx_uuid: txUuid, status: "PENDING" };
  }

  if (!result.success) {
    // tx_uuid_conflict means this tx_uuid is already occupied by a DIFFERENT
    // transaction (the transfer()-level settlement-slot-hijack guard) -- must
    // not be filed as FAILED_INSUFFICIENT, which would misleadingly suggest
    // this device's own money was the problem.
    const status: OfflineIntentStatus = result.failureReason === "tx_uuid_conflict" ? "FAILED_CONFLICT" : "FAILED_INSUFFICIENT";
    await db.updateTable("offline_intents").set({ status }).where("tx_uuid", "=", txUuid).execute();
    return { tx_uuid: txUuid, status };
  }

  await db.updateTable("offline_intents").set({ status: "SETTLED" }).where("tx_uuid", "=", txUuid).execute();
  return {
    tx_uuid: txUuid,
    status: "SETTLED",
    settled_at: result.settledAt.toISOString(),
    receipt: Buffer.from(result.receiptSignature).toString("base64"),
  };
}
