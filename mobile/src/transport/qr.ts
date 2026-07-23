import { bytesToUuid, cborCodec, uuidToBytes } from '@tappay/shared';
import { base64ToBytes, bytesToBase64 } from '../util/base64';

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

/**
 * The payee's "Request" QR (unsigned, by design -- see TapScreen.tsx's doc
 * comment on the 3-QR round trip for why this doesn't need a signature: the
 * payer's proposal is what's cryptographically bound to a transaction, this
 * is just an invitation carrying the nonce that proposal must embed).
 */
export interface TxRequest {
  recipientDeviceId: string; // uuid
  receiverNonce: Uint8Array;
  ts: number;
}

export function encodeTxRequest(request: TxRequest): Uint8Array {
  return cborCodec.encode([uuidToBytes(request.recipientDeviceId), request.receiverNonce, request.ts]);
}

export function decodeTxRequest(bytes: Uint8Array): TxRequest {
  const decoded = cborCodec.decode(bytes);
  if (!Array.isArray(decoded) || decoded.length !== 3) {
    throw new Error('malformed TxRequest CBOR: expected a 3-element array');
  }
  const [recipientDeviceIdBytes, receiverNonce, ts] = decoded;
  return { recipientDeviceId: bytesToUuid(recipientDeviceIdBytes), receiverNonce, ts: Number(ts) };
}
