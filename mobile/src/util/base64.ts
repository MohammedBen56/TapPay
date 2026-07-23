/**
 * Minimal, self-contained base64 encode/decode. React Native/Hermes has no
 * global `Buffer` and no `btoa`/`atob` by default, unlike Node -- pulling in a
 * dependency for something this small isn't worth it, and hand-rolling it here
 * means no surprise behavior difference from whatever a polyfill might do.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bitBuffer = 0;
  let bitCount = 0;
  let outIndex = 0;
  for (const char of clean) {
    const value = ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`invalid base64 character: ${char}`);
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIndex++] = (bitBuffer >> bitCount) & 0xff;
    }
  }
  return out;
}
