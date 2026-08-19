import {
  decodeIncomingIouInfo,
  decodeTxProposal,
  decodeTxReceipt,
  decodeTxRequest,
} from "./cbor.js";
import { decodeCoseSign1Unverified, verifyCoseSign1 } from "./cose.js";
import type { IncomingIouInfo, TxProposal, TxReceipt, TxRequest } from "../types.js";

/**
 * Generalizes the peer-payload sniffing heuristic TapScreen.tsx hand-rolled
 * (try-decode-as-receipt, fall back to try-decode-as-request) into a single
 * classifier covering every payload shape the unified payment flow
 * (mobile/src/payments/paymentFlow.ts, Phase 5) can scan from a peer: this is
 * what lets the receive side collapse into one scan step instead of the old
 * screens' manual per-mode toggle.
 *
 * Ordering is deliberate and matters for correctness, not just style:
 *  1. Server-signed COSE_Sign1 (verified against `serverPublicKey`) can only
 *     be a TxReceipt -- checked first because it's the one shape with an
 *     actual cryptographic guarantee attached.
 *  2. A COSE_Sign1 structure that ISN'T server-signed can only be a payer's
 *     TxProposal. Deliberately NOT signature-verified here: the scanning
 *     device has no way to look up an arbitrary peer's identity_pubkey on its
 *     own -- POST /tx/submit is the actual verification boundary (the
 *     server resolves sender_device_id and checks the signature there).
 *     OfflineIou is never scanned as a peer QR (Mode C's signed IOU goes
 *     straight to /tx/sync; only the unsigned IncomingIouInfo below travels
 *     peer-to-peer), so there's no ambiguity to resolve within this branch.
 *  3. Unsigned wire types (IncomingIouInfo, TxRequest) are structurally
 *     similar (both are small fixed-position CBOR arrays of similar length)
 *     -- each decode is followed by a field-type sanity check so a payload
 *     of one shape can't silently mis-decode as the other (CBOR arrays carry
 *     no field names, so a naive positional decode alone can't tell them
 *     apart; see this file's tests for a concrete case where it would).
 */
export type ClassifiedPeerPayload =
  | { kind: "receipt"; receipt: TxReceipt }
  | { kind: "proposal"; proposal: TxProposal }
  | { kind: "iou_info"; info: IncomingIouInfo }
  | { kind: "request"; request: TxRequest }
  | { kind: "unknown" };

export function classifyPeerPayload(bytes: Uint8Array, serverPublicKey: Uint8Array): ClassifiedPeerPayload {
  // verifyCoseSign1 only returns null for a signature MISMATCH -- malformed
  // COSE/CBOR structure (garbage bytes, a non-COSE payload) makes its inner
  // decode throw instead. Every branch below already assumes "not this
  // shape" on any failure, so treat a thrown decode the same as a null
  // verification result here rather than letting it escape uncaught.
  let verified: ReturnType<typeof verifyCoseSign1> = null;
  try {
    verified = verifyCoseSign1(bytes, serverPublicKey);
  } catch {
    // Not a COSE_Sign1 structure at all -- fall through to the other shapes.
  }
  if (verified) {
    try {
      return { kind: "receipt", receipt: decodeTxReceipt(verified.payload) };
    } catch {
      // Genuinely server-signed but not a receipt shape -- shouldn't happen
      // for anything this project scans as a peer payload; fail safe rather
      // than throw.
    }
  }

  try {
    const unverified = decodeCoseSign1Unverified(bytes);
    return { kind: "proposal", proposal: decodeTxProposal(unverified.payload) };
  } catch {
    // Not a COSE_Sign1 structure at all, or its payload isn't a TxProposal.
  }

  try {
    const info = decodeIncomingIouInfo(bytes);
    // currency is the 4th field here vs. a boolean (receiver_online) at the
    // same position in TxRequest -- a bare positional decode can't otherwise
    // tell the two apart (see this file's doc comment).
    if (typeof info.currency === "string") {
      return { kind: "iou_info", info };
    }
  } catch {
    // Not an IncomingIouInfo-shaped array.
  }

  try {
    const request = decodeTxRequest(bytes);
    if (typeof request.receiver_online === "boolean") {
      return { kind: "request", request };
    }
  } catch {
    // Not a TxRequest-shaped array either.
  }

  return { kind: "unknown" };
}
