import { bytesToUuid, decodeCoseSign1Unverified, decodeTxProposal, uuidToBytes, verifyCoseSign1 } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../../adapters/index.js";
import { config } from "../../config.js";
import { findDeviceAccount } from "./deviceLookup.js";

const txSubmitBodySchema = z.object({
  cose_sign1: z.string(), // base64
});

/** The parked P2P-proximity half of the original tx.ts: a COSE_Sign1-signed
 * TxProposal, verified against a device's hardware-attested identity key.
 * Registered only when proximity routes are enabled (see app.ts) -- the v2
 * neobank MVP's /transfers route (routes/transfers.ts once M1d lands) is the
 * live equivalent for a Bearer-authenticated customer session. */
export function registerTxCoseRoutes(app: FastifyInstance): void {
  app.post(
    "/tx/submit",
    { config: { rateLimit: { max: config.rateLimitTxSubmitMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
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

      // Without this, a non-positive or absurd amount reaches the DB's
      // `CHECK (amount > 0)` constraint and surfaces as an untyped 500 with raw
      // Postgres text, and an unsupported currency would silently query/journal
      // a balance that can never actually hold funds.
      if (proposal.amount <= 0n || proposal.amount > config.maxTransferMinorUnits) {
        return reply.status(400).send({ error: "InvalidAmount", message: "amount must be positive and within the allowed limit" });
      }
      if (!config.supportedCurrencies.includes(proposal.currency)) {
        return reply.status(400).send({ error: "InvalidCurrency", message: `unsupported currency: ${proposal.currency}` });
      }

      let txUuid: string;
      try {
        txUuid = bytesToUuid(proposal.tx_uuid);
      } catch {
        return reply.status(400).send({ error: "InvalidRequest", message: "tx_uuid is not a valid 16-byte UUID" });
      }
      const result = await bankAdapter.transfer(
        txUuid,
        senderLookup.account.account_id,
        recipientLookup.account.account_id,
        proposal.amount,
        proposal.currency,
        { recipientDeviceId: proposal.recipient_device_id, receiverNonce: proposal.receiver_nonce },
      );

      if (!result.success) {
        if (result.failureReason === "tx_uuid_conflict") {
          // Deliberately discloses nothing about the row already occupying this
          // tx_uuid -- no receipt, no hint of who the original parties were.
          return reply.status(409).send({ error: "TxUuidConflict", message: "tx_uuid is already in use by a different transaction" });
        }
        if (result.failureReason === "reservation_expired") {
          return reply.status(409).send({ error: "ReservationExpired", message: result.failureReason });
        }
        return reply.status(409).send({ error: "InsufficientFunds", message: result.failureReason });
      }

      return reply.send({
        tx_uuid: txUuid,
        settled_at: result.settledAt.toISOString(),
        receipt: Buffer.from(result.receiptSignature).toString("base64"),
      });
    },
  );
}
