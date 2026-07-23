/**
 * DER <-> raw r||s conversion for P-256 ECDSA signatures.
 *
 * Android's `Signature.sign()` (KeyStoreManager, M1 Step 6) returns a DER-encoded
 * ECDSA signature -- Java's convention. COSE (RFC 8152 §8.1) requires raw,
 * fixed-width r||s (64 bytes for P-256). Node's own signer (Step 5/8, server
 * identity key) asks for raw output directly via the `dsaEncoding` option, so only
 * the mobile path needs this conversion -- but it lives here, in shared code, so
 * it's tested once centrally rather than reimplemented per platform.
 *
 * The two cases that actually break naive converters, both covered by this file's
 * vector test: a DER INTEGER carrying a leading 0x00 byte (emitted whenever the
 * high bit of r or s is set, to keep the ASN.1 INTEGER non-negative), and an r/s
 * shorter than 32 bytes that must be left-padded with zeros, not concatenated short.
 */

const FIELD_SIZE = 32; // P-256 field element width in bytes

function readDerInteger(der: Uint8Array, offset: number): { bytes: Uint8Array; next: number } {
  if (der[offset] !== 0x02) {
    throw new Error(`malformed DER signature: expected INTEGER tag (0x02) at offset ${offset}`);
  }
  const len = der[offset + 1];
  if (len === undefined || len >= 0x80) {
    // P-256 r/s never need long-form DER length (max 33 bytes); a long-form
    // length here means malformed or unsupported input, not a valid signature.
    throw new Error("malformed DER signature: unsupported or missing INTEGER length");
  }
  const start = offset + 2;
  const bytes = der.slice(start, start + len);
  if (bytes.length !== len) {
    throw new Error("malformed DER signature: truncated INTEGER");
  }
  return { bytes, next: start + len };
}

function toFixedWidth(bytes: Uint8Array): Uint8Array {
  let trimmed = bytes;
  if (trimmed.length > FIELD_SIZE) {
    // Only a single sign-guard 0x00 byte is ever legitimate here (P-256 field
    // elements never require more than one padding byte to stay non-negative).
    if (trimmed.length !== FIELD_SIZE + 1 || trimmed[0] !== 0x00) {
      throw new Error(`malformed DER signature: INTEGER too long for P-256 field (${trimmed.length} bytes)`);
    }
    trimmed = trimmed.slice(1);
  }
  if (trimmed.length === FIELD_SIZE) return trimmed;
  const out = new Uint8Array(FIELD_SIZE);
  out.set(trimmed, FIELD_SIZE - trimmed.length); // left-pad with zeros
  return out;
}

/** DER-encoded ECDSA signature -> raw 64-byte r||s (COSE ES256 format). */
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) {
    throw new Error("malformed DER signature: expected SEQUENCE tag (0x30)");
  }
  const seqLen = der[1];
  if (seqLen === undefined || seqLen >= 0x80) {
    throw new Error("malformed DER signature: unsupported or missing SEQUENCE length");
  }
  const { bytes: rBytes, next } = readDerInteger(der, 2);
  const { bytes: sBytes } = readDerInteger(der, next);

  const raw = new Uint8Array(FIELD_SIZE * 2);
  raw.set(toFixedWidth(rBytes), 0);
  raw.set(toFixedWidth(sBytes), FIELD_SIZE);
  return raw;
}

function toDerInteger(fixed32: Uint8Array): Uint8Array {
  let start = 0;
  while (start < fixed32.length - 1 && fixed32[start] === 0x00) start++;
  let trimmed = fixed32.slice(start);
  if ((trimmed[0]! & 0x80) !== 0) {
    // High bit set -- prepend a 0x00 sign-guard so DER doesn't read this as negative.
    const padded = new Uint8Array(trimmed.length + 1);
    padded.set(trimmed, 1);
    trimmed = padded;
  }
  const out = new Uint8Array(2 + trimmed.length);
  out[0] = 0x02;
  out[1] = trimmed.length;
  out.set(trimmed, 2);
  return out;
}

/** Raw 64-byte r||s -> DER-encoded ECDSA signature. Provided for completeness /
 * interop with DER-only verifiers; this project's own verify path never needs it. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== FIELD_SIZE * 2) {
    throw new Error(`expected a ${FIELD_SIZE * 2}-byte raw signature, got ${raw.length}`);
  }
  const r = toDerInteger(raw.slice(0, FIELD_SIZE));
  const s = toDerInteger(raw.slice(FIELD_SIZE));
  const body = new Uint8Array(r.length + s.length);
  body.set(r, 0);
  body.set(s, r.length);
  if (body.length >= 0x80) {
    throw new Error("unexpected DER SEQUENCE length >= 0x80 for a P-256 signature");
  }
  const out = new Uint8Array(2 + body.length);
  out[0] = 0x30;
  out[1] = body.length;
  out.set(body, 2);
  return out;
}
