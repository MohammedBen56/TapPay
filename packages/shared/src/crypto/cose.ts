import { Encoder, Tag } from "cbor-x";
import { verifyEcdsaP256 } from "./ecdsa.js";

// tagUint8Array: false is load-bearing, not cosmetic -- cbor-x's default is to tag
// Uint8Array with CBOR tag(64) specifically when Node's global Buffer is present,
// but leave a decoded Buffer instance untagged. Left on default, the exact same
// logical bytes encode differently depending on whether a value happens to be a
// Buffer or a plain Uint8Array, and differently again on a platform (Hermes/RN)
// where Buffer isn't globally defined at all -- silently breaking both signature
// verification (a locally-rebuilt Sig_structure no longer matches what was
// actually signed) and the Hermes byte-identity guarantee this module depends on.
const structureCodec = new Encoder({ useRecords: false, mapsAsObjects: true, tagUint8Array: false });

/** COSE algorithm identifier for ECDSA w/ SHA-256 (RFC 8152 §8.1 / IANA COSE registry). */
const ES256 = -7;
const PROTECTED_HEADER_BYTES = structureCodec.encode(new Map([[1, ES256]]));
const EMPTY_UNPROTECTED_HEADER = new Map<number, unknown>();
const EMPTY_EXTERNAL_AAD = new Uint8Array(0);

/** Must return a raw 64-byte r||s signature (COSE ES256 format), not DER. On the
 * server this wraps Node's crypto.sign with `dsaEncoding: "ieee-p1363"`; on mobile
 * it wraps the native hardware-backed sign call plus ecdsaDer.derToRaw(), since
 * Android's Signature API returns DER. */
export type Signer = (bytesToSign: Uint8Array) => Promise<Uint8Array>;

function buildSigStructure(protectedHeaderBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  // RFC 8152 §4.4. external_aad is always empty in this project -- no third
  // context data is bound outside the payload itself.
  return structureCodec.encode(["Signature1", protectedHeaderBytes, EMPTY_EXTERNAL_AAD, payload]);
}

/** Signs `payload` and returns the untagged 4-element COSE_Sign1 array bytes
 * (protected header carries alg:ES256; unprotected header is empty). Untagged is
 * a valid COSE_Sign1 form (RFC 8152 §2) -- this project always knows from context
 * that a given message is a COSE_Sign1, so the CBOR tag(18) prefix is redundant
 * and dropped to keep the wire payload (QR-bound, M1 Step 9) a few bytes smaller. */
export async function signCoseSign1(payload: Uint8Array, sign: Signer): Promise<Uint8Array> {
  const sigStructure = buildSigStructure(PROTECTED_HEADER_BYTES, payload);
  const signature = await sign(sigStructure);
  return structureCodec.encode([PROTECTED_HEADER_BYTES, EMPTY_UNPROTECTED_HEADER, payload, signature]);
}

export interface VerifiedCoseSign1 {
  payload: Uint8Array;
  signature: Uint8Array;
}

function decodeCoseSign1Structure(coseBytes: Uint8Array): [Uint8Array, unknown, Uint8Array, Uint8Array] {
  let decoded: unknown = structureCodec.decode(coseBytes);
  if (decoded instanceof Tag && decoded.tag === 18) {
    decoded = decoded.value;
  }
  if (!Array.isArray(decoded) || decoded.length !== 4) {
    throw new Error("malformed COSE_Sign1: expected a 4-element array");
  }
  return decoded as [Uint8Array, unknown, Uint8Array, Uint8Array];
}

/**
 * Decodes the outer COSE_Sign1 container WITHOUT checking the signature.
 * UNTRUSTED -- the only legitimate use is reading routing metadata (e.g.
 * TxProposal.sender_device_id) needed to look up which public key to verify
 * against in the first place, the same "read kid, then verify" pattern JWT
 * libraries use. Nothing read this way may be acted on, persisted, or used to
 * move money -- only verifyCoseSign1's return value is trustworthy.
 */
export function decodeCoseSign1Unverified(coseBytes: Uint8Array): { payload: Uint8Array } {
  const [, , payload] = decodeCoseSign1Structure(coseBytes);
  return { payload };
}

/**
 * Verifies a COSE_Sign1 structure and returns its payload bytes -- ONLY if the
 * signature is valid; returns null otherwise. Tolerates an optional leading
 * CBOR tag(18) wrapper for interop, but never requires one.
 *
 * Reconstructs the Sig_structure from the protected-header and payload bytes AS
 * RECEIVED, never by re-encoding the decoded object. This is the single most
 * common way COSE interop breaks in practice: a verifier that decodes then
 * re-serializes before checking the signature will reject a perfectly valid
 * signature the moment the original encoder and the re-encoder disagree on
 * anything non-canonical (field order, integer encoding length, etc.). Callers
 * must only decode the payload's fields (cbor.ts) AFTER this returns non-null,
 * never before or as a substitute for verification.
 */
export function verifyCoseSign1(coseBytes: Uint8Array, publicKey: Uint8Array): VerifiedCoseSign1 | null {
  const [protectedHeaderBytes, , payload, signature] = decodeCoseSign1Structure(coseBytes);

  const sigStructure = buildSigStructure(protectedHeaderBytes, payload);
  const ok = verifyEcdsaP256(sigStructure, signature, publicKey);
  return ok ? { payload, signature } : null;
}
