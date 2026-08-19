import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import type { IncomingIouInfo, TxProposal, TxReceipt, TxRequest } from "../../types.js";
import { encodeIncomingIouInfo, encodeTxProposal, encodeTxReceipt, encodeTxRequest } from "../cbor.js";
import { classifyPeerPayload } from "../classify.js";
import { signCoseSign1, type Signer } from "../cose.js";

function bytes16(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill);
}

// Same pattern as session.test.ts's makeIdentity() -- a fresh in-test P-256
// keypair standing in for a hardware identity key or the server's signing key.
function makeIdentity(): { sign: Signer; publicKey: Uint8Array } {
  const { secretKey, publicKey } = p256.keygen();
  const sign: Signer = async (bytesToSign) => p256.sign(sha256(bytesToSign), secretKey, { lowS: false }).toBytes("compact");
  return { sign, publicKey };
}

describe("classifyPeerPayload", () => {
  it("classifies a server-signed TxReceipt as 'receipt'", async () => {
    const server = makeIdentity();
    const receipt: TxReceipt = {
      tx_uuid: bytes16(1),
      settled_at: 1_784_764_600_000,
      amount: 500n,
      currency: "MAD",
      recipient_device_id: bytes16(2),
      receiver_nonce: bytes16(3),
    };
    const coseBytes = await signCoseSign1(encodeTxReceipt(receipt), server.sign);

    const result = classifyPeerPayload(coseBytes, server.publicKey);

    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.amount).toBe(500n);
      expect(result.receipt.currency).toBe("MAD");
    }
  });

  it("classifies a peer-signed (non-server) TxProposal as 'proposal', without verifying its signature", async () => {
    const server = makeIdentity();
    const payer = makeIdentity(); // a different key than the server's
    const proposal: TxProposal = {
      tx_uuid: bytes16(4),
      sender_device_id: bytes16(5),
      recipient_device_id: bytes16(6),
      amount: 1_000n,
      currency: "MAD",
      receiver_nonce: bytes16(7),
      ts: 1_784_764_600_000,
    };
    const coseBytes = await signCoseSign1(encodeTxProposal(proposal), payer.sign);

    // Verified against the SERVER's public key, not the payer's -- this is
    // the real-world call shape (a scanner only ever has the pinned server
    // key on hand, never an arbitrary peer's identity_pubkey in advance).
    const result = classifyPeerPayload(coseBytes, server.publicKey);

    expect(result.kind).toBe("proposal");
    if (result.kind === "proposal") {
      expect(result.proposal.amount).toBe(1_000n);
      expect(Array.from(result.proposal.sender_device_id)).toEqual(Array.from(bytes16(5)));
    }
  });

  it("classifies an unsigned IncomingIouInfo as 'iou_info'", () => {
    const server = makeIdentity();
    const info: IncomingIouInfo = { tx_uuid: bytes16(8), sender_device_id: bytes16(9), amount: 250n, currency: "MAD" };

    const result = classifyPeerPayload(encodeIncomingIouInfo(info), server.publicKey);

    expect(result.kind).toBe("iou_info");
    if (result.kind === "iou_info") {
      expect(result.info.amount).toBe(250n);
    }
  });

  it("classifies an unsigned TxRequest as 'request'", () => {
    const server = makeIdentity();
    const request: TxRequest = { recipient_device_id: bytes16(10), receiver_nonce: bytes16(11), ts: 1_784_764_600_000, receiver_online: true };

    const result = classifyPeerPayload(encodeTxRequest(request), server.publicKey);

    expect(result.kind).toBe("request");
    if (result.kind === "request") {
      expect(result.request.receiver_online).toBe(true);
    }
  });

  it("does NOT mis-classify a TxRequest as an IncomingIouInfo, despite both being 4-element unsigned CBOR arrays", () => {
    // The concrete case classify.ts's doc comment warns about: IncomingIouInfo's
    // 4th field (currency) is a string, TxRequest's 4th field (receiver_online)
    // is a boolean, at the exact same array position -- a bare positional
    // decode can't tell them apart without a type check.
    const server = makeIdentity();
    const request: TxRequest = { recipient_device_id: bytes16(12), receiver_nonce: bytes16(13), ts: 1_784_764_600_000, receiver_online: false };

    const result = classifyPeerPayload(encodeTxRequest(request), server.publicKey);

    expect(result.kind).toBe("request");
  });

  it("returns 'unknown' for bytes that match none of the known shapes", () => {
    const server = makeIdentity();
    const garbage = new Uint8Array([0xff, 0x00, 0x01, 0x02, 0x03]);

    const result = classifyPeerPayload(garbage, server.publicKey);

    expect(result.kind).toBe("unknown");
  });
});
