import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";

/**
 * Portable ECDSA-P256/SHA-256 signature verification -- usable identically on the
 * server (Node) and the mobile app (Hermes/RN). React Native does not provide
 * WebCrypto's SubtleCrypto by default, so verification is implemented directly
 * against @noble/curves (pure JS, no native bindings) rather than delegating to
 * crypto.subtle, which would only work on one of the two platforms.
 *
 * Accepts a raw SEC1 public key (compressed 33 bytes or uncompressed 65 bytes --
 * @noble/curves handles both natively) and a raw 64-byte r||s signature (COSE's
 * ES256 format per RFC 8152 §8.1 -- never DER; see ecdsaDer.ts for that
 * conversion, needed only on the mobile signing path).
 */
export function verifyEcdsaP256(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  const hash = sha256(message);
  try {
    return p256.verify(signature, hash, publicKey, { format: "compact", lowS: false });
  } catch {
    return false;
  }
}
