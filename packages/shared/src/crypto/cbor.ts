import { Encoder } from "cbor-x";
import type {
  DeviceCredential,
  FreshnessToken,
  IncomingIouInfo,
  OfflineIou,
  SessionHello,
  TxProposal,
  TxReceipt,
} from "../types.js";

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

/** Mode C's IOU payload -- see OfflineIou's doc comment (types.ts) for why the
 * field order matches spec §5's 5-field list plus the two device-id fields
 * TxProposal already establishes the pattern for. Field order is the wire
 * contract, same rule as TX_PROPOSAL_FIELD_ORDER above. */
const OFFLINE_IOU_FIELD_ORDER = [
  "tx_uuid",
  "sender_device_id",
  "recipient_device_id",
  "amount",
  "currency",
  "seq",
  "ts",
] as const;

export function encodeOfflineIou(iou: OfflineIou): Uint8Array {
  return cborCodec.encode(OFFLINE_IOU_FIELD_ORDER.map((key) => iou[key]));
}

export function decodeOfflineIou(bytes: Uint8Array): OfflineIou {
  const decoded = cborCodec.decode(bytes);
  if (!Array.isArray(decoded) || decoded.length !== OFFLINE_IOU_FIELD_ORDER.length) {
    throw new Error("malformed OfflineIou CBOR: expected a 7-element array");
  }
  const [tx_uuid, sender_device_id, recipient_device_id, amount, currency, seq, ts] = decoded;
  return {
    tx_uuid,
    sender_device_id,
    recipient_device_id,
    amount: BigInt(amount),
    currency,
    seq: BigInt(seq),
    ts: Number(ts),
  };
}

const FRESHNESS_TOKEN_FIELD_ORDER = ["device_id", "issued_at"] as const;

export function encodeFreshnessToken(token: FreshnessToken): Uint8Array {
  return cborCodec.encode(FRESHNESS_TOKEN_FIELD_ORDER.map((key) => token[key]));
}

export function decodeFreshnessToken(bytes: Uint8Array): FreshnessToken {
  const decoded = cborCodec.decode(bytes);
  if (!Array.isArray(decoded) || decoded.length !== FRESHNESS_TOKEN_FIELD_ORDER.length) {
    throw new Error("malformed FreshnessToken CBOR: expected a 2-element array");
  }
  const [device_id, issued_at] = decoded;
  return { device_id, issued_at: Number(issued_at) };
}

/** Unsigned by design -- see IncomingIouInfo's doc comment (types.ts). Field
 * order is still a real wire contract even though it's not cryptographically
 * bound to anything, so a payee's QR scanner always decodes it the same way. */
const INCOMING_IOU_INFO_FIELD_ORDER = ["tx_uuid", "sender_device_id", "amount", "currency"] as const;

export function encodeIncomingIouInfo(info: IncomingIouInfo): Uint8Array {
  return cborCodec.encode(INCOMING_IOU_INFO_FIELD_ORDER.map((key) => info[key]));
}

export function decodeIncomingIouInfo(bytes: Uint8Array): IncomingIouInfo {
  const decoded = cborCodec.decode(bytes);
  if (!Array.isArray(decoded) || decoded.length !== INCOMING_IOU_INFO_FIELD_ORDER.length) {
    throw new Error("malformed IncomingIouInfo CBOR: expected a 4-element array");
  }
  const [tx_uuid, sender_device_id, amount, currency] = decoded;
  return { tx_uuid, sender_device_id, amount: BigInt(amount), currency };
}

/** GET /devices/:deviceId/credential's signed payload -- see DeviceCredential's
 * doc comment (types.ts) for why attestation_ok isn't a field here. Field order
 * is the wire contract, same rule as every codec above. */
const DEVICE_CREDENTIAL_FIELD_ORDER = ["device_id", "identity_pubkey", "issued_at"] as const;

export function encodeDeviceCredential(credential: DeviceCredential): Uint8Array {
  return cborCodec.encode(DEVICE_CREDENTIAL_FIELD_ORDER.map((key) => credential[key]));
}

export function decodeDeviceCredential(bytes: Uint8Array): DeviceCredential {
  const decoded = cborCodec.decode(bytes);
  if (!Array.isArray(decoded) || decoded.length !== DEVICE_CREDENTIAL_FIELD_ORDER.length) {
    throw new Error("malformed DeviceCredential CBOR: expected a 3-element array");
  }
  const [device_id, identity_pubkey, issued_at] = decoded;
  return { device_id, identity_pubkey, issued_at: Number(issued_at) };
}

/** Authenticated session ECDH's handshake payload -- see SessionHello's doc
 * comment (types.ts). Field order is the wire contract, same rule as every
 * codec above. */
const SESSION_HELLO_FIELD_ORDER = ["tx_uuid", "device_id", "eph_pubkey", "ts"] as const;

export function encodeSessionHello(hello: SessionHello): Uint8Array {
  return cborCodec.encode(SESSION_HELLO_FIELD_ORDER.map((key) => hello[key]));
}

export function decodeSessionHello(bytes: Uint8Array): SessionHello {
  const decoded = cborCodec.decode(bytes);
  if (!Array.isArray(decoded) || decoded.length !== SESSION_HELLO_FIELD_ORDER.length) {
    throw new Error("malformed SessionHello CBOR: expected a 4-element array");
  }
  const [tx_uuid, device_id, eph_pubkey, ts] = decoded;
  return { tx_uuid, device_id, eph_pubkey, ts: Number(ts) };
}
