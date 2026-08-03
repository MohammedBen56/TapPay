import { Encoder } from "cbor-x";
import { describe, expect, it } from "vitest";
import {
  decodeFreshnessToken,
  decodeIncomingIouInfo,
  decodeOfflineIou,
  decodeTxProposal,
  decodeTxReceipt,
  encodeFreshnessToken,
  encodeIncomingIouInfo,
  encodeOfflineIou,
  encodeTxProposal,
  encodeTxReceipt,
} from "../cbor.js";
import type { FreshnessToken, IncomingIouInfo, OfflineIou, TxProposal, TxReceipt } from "../../types.js";

function bytes16(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill);
}

// cbor-x decodes byte strings as Node Buffer, not plain Uint8Array. Buffer IS a
// Uint8Array subclass (identical bytes, identical behavior for every real use),
// but vitest's toEqual treats the two constructors as unequal -- a test-harness
// quirk, not a production concern. Normalize before comparing.
function normalizeBytes<T>(value: T): T {
  if (value instanceof Uint8Array) return Array.from(value) as T;
  if (Array.isArray(value)) return value.map(normalizeBytes) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeBytes(v)])) as T;
  }
  return value;
}

describe("TxProposal CBOR round-trip", () => {
  it("round-trips every field exactly, including a bigint amount beyond safe-integer range", () => {
    const proposal: TxProposal = {
      tx_uuid: bytes16(1),
      sender_device_id: bytes16(2),
      recipient_device_id: bytes16(3),
      amount: 9_007_199_254_740_993n, // MAX_SAFE_INTEGER + 2
      currency: "MAD",
      receiver_nonce: bytes16(4),
      ts: 1_784_764_600_000,
    };

    const decoded = decodeTxProposal(encodeTxProposal(proposal));

    expect(normalizeBytes(decoded)).toEqual(normalizeBytes(proposal));
    expect(typeof decoded.amount).toBe("bigint");
  });

  it("normalizes amount to bigint even for small values cbor-x would decode as Number", () => {
    const proposal: TxProposal = {
      tx_uuid: bytes16(1),
      sender_device_id: bytes16(2),
      recipient_device_id: bytes16(3),
      amount: 500n, // well within Number range -- exercises the normalization path
      currency: "MAD",
      receiver_nonce: bytes16(4),
      ts: 0,
    };

    const decoded = decodeTxProposal(encodeTxProposal(proposal));
    expect(typeof decoded.amount).toBe("bigint");
    expect(decoded.amount).toBe(500n);
  });

  it("rejects a malformed (wrong-arity) CBOR array rather than returning partial garbage", () => {
    // Not a real cbor.encode call site anywhere in this codebase -- constructing
    // bytes for a 3-element array directly to prove decodeTxProposal validates
    // shape rather than trusting index access to fail silently with `undefined`.
    const encoder = new Encoder({ useRecords: false });
    const malformed = encoder.encode([1, 2, 3]);
    expect(() => decodeTxProposal(malformed)).toThrow();
  });
});

describe("TxReceipt CBOR round-trip", () => {
  it("round-trips every field exactly", () => {
    const receipt: TxReceipt = {
      tx_uuid: bytes16(9),
      settled_at: 1_784_764_600_000,
      amount: 12_345n,
      currency: "MAD",
    };

    const decoded = decodeTxReceipt(encodeTxReceipt(receipt));
    expect(normalizeBytes(decoded)).toEqual(normalizeBytes(receipt));
    expect(typeof decoded.amount).toBe("bigint");
  });
});

describe("OfflineIou CBOR round-trip", () => {
  it("round-trips every field exactly, including bigint amount and seq", () => {
    const iou: OfflineIou = {
      tx_uuid: bytes16(5),
      sender_device_id: bytes16(6),
      recipient_device_id: bytes16(7),
      amount: 9_007_199_254_740_993n,
      currency: "MAD",
      seq: 42n,
      ts: 1_784_764_600_000,
    };

    const decoded = decodeOfflineIou(encodeOfflineIou(iou));

    expect(normalizeBytes(decoded)).toEqual(normalizeBytes(iou));
    expect(typeof decoded.amount).toBe("bigint");
    expect(typeof decoded.seq).toBe("bigint");
  });

  it("normalizes seq to bigint even for small values cbor-x would decode as Number", () => {
    const iou: OfflineIou = {
      tx_uuid: bytes16(5),
      sender_device_id: bytes16(6),
      recipient_device_id: bytes16(7),
      amount: 100n,
      currency: "MAD",
      seq: 1n,
      ts: 0,
    };

    const decoded = decodeOfflineIou(encodeOfflineIou(iou));
    expect(decoded.seq).toBe(1n);
  });

  it("rejects a malformed (wrong-arity) CBOR array rather than returning partial garbage", () => {
    const encoder = new Encoder({ useRecords: false });
    const malformed = encoder.encode([1, 2, 3]);
    expect(() => decodeOfflineIou(malformed)).toThrow();
  });
});

describe("FreshnessToken CBOR round-trip", () => {
  it("round-trips every field exactly", () => {
    const token: FreshnessToken = {
      device_id: bytes16(8),
      issued_at: 1_784_764_600_000,
    };

    const decoded = decodeFreshnessToken(encodeFreshnessToken(token));
    expect(normalizeBytes(decoded)).toEqual(normalizeBytes(token));
  });

  it("rejects a malformed (wrong-arity) CBOR array rather than returning partial garbage", () => {
    const encoder = new Encoder({ useRecords: false });
    const malformed = encoder.encode([1, 2, 3]);
    expect(() => decodeFreshnessToken(malformed)).toThrow();
  });
});

describe("IncomingIouInfo CBOR round-trip", () => {
  it("round-trips every field exactly, including bigint amount", () => {
    const info: IncomingIouInfo = {
      tx_uuid: bytes16(9),
      sender_device_id: bytes16(10),
      amount: 9_007_199_254_740_993n,
      currency: "MAD",
    };

    const decoded = decodeIncomingIouInfo(encodeIncomingIouInfo(info));

    expect(normalizeBytes(decoded)).toEqual(normalizeBytes(info));
    expect(typeof decoded.amount).toBe("bigint");
  });

  it("normalizes amount to bigint even for small values cbor-x would decode as Number", () => {
    const info: IncomingIouInfo = {
      tx_uuid: bytes16(9),
      sender_device_id: bytes16(10),
      amount: 100n,
      currency: "MAD",
    };

    const decoded = decodeIncomingIouInfo(encodeIncomingIouInfo(info));
    expect(decoded.amount).toBe(100n);
  });

  it("rejects a malformed (wrong-arity) CBOR array rather than returning partial garbage", () => {
    const encoder = new Encoder({ useRecords: false });
    const malformed = encoder.encode([1, 2]);
    expect(() => decodeIncomingIouInfo(malformed)).toThrow();
  });
});
