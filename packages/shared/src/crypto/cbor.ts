import { Encoder } from "cbor-x";
import type { TxProposal, TxReceipt } from "../types.js";

/**
 * A dedicated Encoder instance (not cbor-x's shared default) so unrelated global
 * cbor-x configuration elsewhere can never silently affect signed-payload bytes.
 * `useRecords: false` disables cbor-x's stateful object->record-shorthand
 * optimization, which assigns short numeric aliases to object shapes it has seen
 * before -- convenient for general use, but exactly the kind of cross-call,
 * order-dependent state a *signed* payload's encoding must never depend on.
 */
// tagUint8Array: false -- see the identical comment in cose.ts; same determinism
// hazard applies here (TxProposal/TxReceipt fields include raw Uint8Array ids).
export const cborCodec = new Encoder({ useRecords: false, mapsAsObjects: true, tagUint8Array: false });

/**
 * TxProposal/TxReceipt encode as fixed-position CBOR arrays, not maps -- smaller
 * on the wire (no field-name overhead), which matters since these bytes end up
 * inside a QR code (M1 Step 9). Field order is the wire contract: changing it is
 * a breaking change, not a refactor.
 */
const TX_PROPOSAL_FIELD_ORDER = [
  "tx_uuid",
  "sender_device_id",
  "recipient_device_id",
  "amount",
  "currency",
  "receiver_nonce",
  "ts",
] as const;

export function encodeTxProposal(proposal: TxProposal): Uint8Array {
  return cborCodec.encode(TX_PROPOSAL_FIELD_ORDER.map((key) => proposal[key]));
}

export function decodeTxProposal(bytes: Uint8Array): TxProposal {
  const decoded = cborCodec.decode(bytes);
  if (!Array.isArray(decoded) || decoded.length !== TX_PROPOSAL_FIELD_ORDER.length) {
    throw new Error("malformed TxProposal CBOR: expected a 7-element array");
  }
  const [tx_uuid, sender_device_id, recipient_device_id, amount, currency, receiver_nonce, ts] = decoded;
  return {
    tx_uuid,
    sender_device_id,
    recipient_device_id,
    // cbor-x decodes small integers as Number and large ones as bigint; normalize
    // to bigint unconditionally so callers never have to care which one it chose.
    amount: BigInt(amount),
    currency,
    receiver_nonce,
    ts: Number(ts),
  };
}

const TX_RECEIPT_FIELD_ORDER = ["tx_uuid", "settled_at", "amount", "currency"] as const;

export function encodeTxReceipt(receipt: TxReceipt): Uint8Array {
  return cborCodec.encode(TX_RECEIPT_FIELD_ORDER.map((key) => receipt[key]));
}

export function decodeTxReceipt(bytes: Uint8Array): TxReceipt {
  const decoded = cborCodec.decode(bytes);
  if (!Array.isArray(decoded) || decoded.length !== TX_RECEIPT_FIELD_ORDER.length) {
    throw new Error("malformed TxReceipt CBOR: expected a 4-element array");
  }
  const [tx_uuid, settled_at, amount, currency] = decoded;
  return {
    tx_uuid,
    settled_at: Number(settled_at),
    amount: BigInt(amount),
    currency,
  };
}
