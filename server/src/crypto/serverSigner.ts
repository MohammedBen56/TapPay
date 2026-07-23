import { readFileSync } from "node:fs";
import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { encodeTxReceipt, signCoseSign1, uuidToBytes, type Signer } from "@tappay/shared";
import { config } from "../config.js";
import type { ReceiptSigner } from "../adapters/MockBankAdapter.js";

const privateKey = createPrivateKey(readFileSync(config.serverIdentityKeyPath));

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
export const signServerReceipt: ReceiptSigner = async ({ txUuid, amount, currency, settledAt }) => {
  const payload = encodeTxReceipt({
    tx_uuid: uuidToBytes(txUuid),
    settled_at: settledAt.getTime(),
    amount,
    currency,
  });
  return signCoseSign1(payload, rawSign);
};
