import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { encodeDeviceCredential, encodeFreshnessToken, encodeTxReceipt, signCoseSign1, uuidToBytes, type Signer } from "@tappay/shared";
import { config } from "../config.js";
import type { ReceiptSigner } from "../adapters/MockBankAdapter.js";
import { compressedPublicKeyFromKeyObject } from "./ecPublicKey.js";

const privateKey = createPrivateKey(readFileSync(config.serverIdentityKeyPath));

/** Derived from the same key that signs receipts/freshness tokens -- used at
 * /tx/sync (M2) to verify a freshness token's own signature was really issued by
 * this server, not fabricated by the client. */
export const serverPublicKeyBytes: Uint8Array = compressedPublicKeyFromKeyObject(createPublicKey(privateKey));

// Raw r||s directly via Node's `dsaEncoding` option -- COSE (RFC 8152 §8.1) wants
// raw, not DER. WebCrypto's subtle.sign also returns raw r||s but is async for no
// benefit here; the legacy `crypto.sign` API is synchronous and gives the same
// COSE-ready output without an extra await.
const rawSign: Signer = async (bytesToSign) =>
  new Uint8Array(nodeSign("sha256", bytesToSign, { key: privateKey, dsaEncoding: "ieee-p1363" }));

/** The real ReceiptSigner wired into MockBankAdapter (Step 8) -- builds the
 * TxReceipt CBOR payload and wraps it in a full COSE_Sign1 structure, matching
 * CommitResult.receiptSignature's documented meaning ("COSE_Sign1 from server
 * identity key"), not just a bare ECDSA signature. */
export const signServerReceipt: ReceiptSigner = async ({ txUuid, amount, currency, settledAt, recipientDeviceId, receiverNonce }) => {
  const payload = encodeTxReceipt({
    tx_uuid: uuidToBytes(txUuid),
    settled_at: settledAt.getTime(),
    amount,
    currency,
    recipient_device_id: recipientDeviceId,
    receiver_nonce: receiverNonce,
  });
  return signCoseSign1(payload, rawSign);
};

/** GET /devices/:deviceId/freshness-token's signer (M2) -- same key/signer as
 * receipts, reused rather than a second identity, since both are just "the
 * server attests to a fact" COSE_Sign1 payloads. */
export async function signFreshnessToken(deviceId: Uint8Array): Promise<Uint8Array> {
  const payload = encodeFreshnessToken({ device_id: deviceId, issued_at: Date.now() });
  return signCoseSign1(payload, rawSign);
}

/** GET /devices/:deviceId/credential's signer -- same key/signer as receipts
 * and freshness tokens, since all three are "the server attests to a fact".
 * Lets a peer verify offline that `identityPubkey` really belongs to
 * `deviceId`, the precondition authenticated session ECDH needs before
 * deriving a shared secret (CLAUDE.md §5). Callers must only invoke this for
 * an attestation_ok device -- see the route, which gates on it before calling. */
export async function signDeviceCredential(deviceId: Uint8Array, identityPubkey: Uint8Array): Promise<Uint8Array> {
  const payload = encodeDeviceCredential({ device_id: deviceId, identity_pubkey: identityPubkey, issued_at: Date.now() });
  return signCoseSign1(payload, rawSign);
}
