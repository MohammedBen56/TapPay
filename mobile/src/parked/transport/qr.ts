import { base64ToBytes, bytesToBase64 } from '../../util/base64';

/**
 * Conservative sanity bound, well below real QR capacity limits (a QR code can
 * hold ~2900 bytes even at low error correction). Every payload here is a
 * signed proposal/receipt or a small request tuple -- all comfortably under
 * a few hundred bytes. If one ever approaches this limit, that's a sign
 * something got encoded wrong (e.g. JSON instead of compact CBOR), not a cue
 * to raise the bound.
 */
export const QR_MAX_BYTES = 2000;

export function bytesToQrString(bytes: Uint8Array): string {
  if (bytes.length > QR_MAX_BYTES) {
    throw new Error(`payload too large for a QR code: ${bytes.length} bytes (max ${QR_MAX_BYTES})`);
  }
  return bytesToBase64(bytes);
}

export function qrStringToBytes(qrString: string): Uint8Array {
  return base64ToBytes(qrString);
}

// TxRequest and its encode/decode functions moved to @tappay/shared (Phase 4)
// -- this file now carries only the QR-transport primitives (base64 <-> bytes
// for whatever payload rides inside the QR), not any wire-format knowledge.
// PayScreen.tsx (Phase 5, replacing TapScreen.tsx/OfflineScreen.tsx) imports
// TxRequest's codec directly from @tappay/shared.
