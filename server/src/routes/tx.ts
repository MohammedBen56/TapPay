import { bytesToUuid, decodeCoseSign1Unverified, decodeTxProposal, uuidToBytes, verifyCoseSign1 } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { config } from "../config.js";
import { db } from "../db/kysely.js";
import { findDeviceAccount } from "./deviceLookup.js";

const txSubmitBodySchema = z.object({
  cose_sign1: z.string(), // base64
});

export function registerTxRoutes(app: FastifyInstance): void {
  app.get("/accounts/:accountId/balance", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const { currency } = request.query as { currency?: string };
    const balance = await bankAdapter.getAvailableBalance(accountId, currency ?? "MAD");
    return reply.send({ account_id: accountId, currency: currency ?? "MAD", available_balance: balance.toString() });
  });

  app.get("/tx/:txUuid/receipt", async (request, reply) => {
    const { txUuid } = request.params as { txUuid: string };
    const reservation = await db
      .selectFrom("reservations")
      .select(["state", "receipt_signature", "settled_at"])
      .where("tx_uuid", "=", txUuid)
      .executeTakeFirst();

    if (!reservation || reservation.state !== "COMMITTED" || !reservation.receipt_signature) {
      return reply.status(404).send({ error: "NotFound", message: "no settled receipt for this tx_uuid" });
    }

    return reply.send({
      tx_uuid: txUuid,
      settled_at: reservation.settled_at,
      receipt: Buffer.from(reservation.receipt_signature).toString("base64"),
    });
  });

  app.post("/tx/submit", async (request, reply) => {
    const parsed = txSubmitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }

    let coseBytes: Uint8Array;
    try {
      coseBytes = new Uint8Array(Buffer.from(parsed.data.cose_sign1, "base64"));
    } catch {
      return reply.status(400).send({ error: "InvalidRequest", message: "cose_sign1 is not valid base64" });
    }

    // Untrusted pre-decode: only used to learn which device's key to verify
    // against, the same "read kid, then verify" pattern JWT libraries use.
    // Nothing from this decode is acted on below -- only the post-verification
    // decode (further down) is trusted.
    let claimedSenderDeviceId: Uint8Array;
    try {
      const unverified = decodeCoseSign1Unverified(coseBytes);
      claimedSenderDeviceId = decodeTxProposal(unverified.payload).sender_device_id;
    } catch {
      return reply.status(400).send({ error: "InvalidRequest", message: "malformed COSE_Sign1 / TxProposal" });
    }

    const senderLookup = await findDeviceAccount(Buffer.from(claimedSenderDeviceId));
    if (!senderLookup) {
      return reply.status(404).send({ error: "UnknownSender", message: "sender device is not enrolled" });
    }
    if (!senderLookup.device.attestation_ok) {
      // Fail closed: an unverified device's signature is never trusted, even
      // if it happens to verify cryptographically -- attestation_ok is the
      // gate, not just the signature check (spec §2.5).
      return reply.status(403).send({ error: "UnverifiedDevice", message: "sender device attestation was not verified" });
    }

    const verified = verifyCoseSign1(coseBytes, new Uint8Array(senderLookup.device.identity_pubkey));
    if (!verified) {
      return reply.status(403).send({ error: "InvalidSignature", message: "COSE_Sign1 signature verification failed" });
    }

    // Only NOW, after signature verification succeeds, is the payload trusted.
    const proposal = decodeTxProposal(verified.payload);

    const freshnessDeltaMs = Math.abs(Date.now() - proposal.ts);
    if (freshnessDeltaMs > config.txFreshnessWindowMs) {
      // A coarse sanity bound, layered BEHIND tx_uuid idempotency (the actual
      // replay defense) -- see packages/shared/src/types.ts's TxProposal doc.
      return reply.status(403).send({ error: "StaleProposal", message: "ts is outside the freshness window" });
    }

    const recipientLookup = await findDeviceAccount(Buffer.from(proposal.recipient_device_id));
    if (!recipientLookup) {
      return reply.status(404).send({ error: "UnknownRecipient", message: "recipient device is not enrolled" });
    }

    if (senderLookup.account.account_id === recipientLookup.account.account_id) {
      // journal's UNIQUE (tx_uuid, account_id) makes a self-transfer structurally
      // impossible to double-journal -- reject explicitly instead of letting the
      // constraint violation surface as an unhandled 500 from transfer() below.
      return reply.status(400).send({ error: "SelfPayment", message: "sender and recipient resolve to the same account" });
    }

    const txUuid = bytesToUuid(proposal.tx_uuid);
    const result = await bankAdapter.transfer(
      txUuid,
      senderLookup.account.account_id,
      recipientLookup.account.account_id,
      proposal.amount,
      proposal.currency,
    );

    if (!result.success) {
      return reply.status(409).send({ error: "TransferFailed", message: result.failureReason });
    }

    return reply.send({
      tx_uuid: txUuid,
      settled_at: result.settledAt.toISOString(),
      receipt: Buffer.from(result.receiptSignature).toString("base64"),
    });
  });
}
