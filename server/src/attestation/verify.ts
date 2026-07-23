import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { OctetString, fromBER } from "asn1js";
import { Certificate } from "pkijs";
import { config } from "../config.js";

/** OID for the Android Key Attestation extension (KeyDescription), present on
 * the leaf certificate of a hardware attestation chain. */
const ANDROID_KEY_ATTESTATION_OID = "1.3.6.1.4.1.11129.2.1.17";

/** Index of `attestationChallenge` within the KeyDescription ASN.1 SEQUENCE.
 * The only field this MVP-scoped verifier reads -- see verifyAttestationChain's
 * doc comment for what's deliberately not parsed (verified-boot state,
 * patch-level, etc.). */
const ATTESTATION_CHALLENGE_FIELD_INDEX = 4;

function loadGoogleRoots(): X509Certificate[] {
  const pem = readFileSync(config.attestationGoogleRootsPath, "utf8");
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) {
    throw new Error(`no certificates found in ${config.attestationGoogleRootsPath}`);
  }
  return blocks.map((block) => new X509Certificate(block));
}

let cachedGoogleRoots: X509Certificate[] | null = null;
function googleRoots(): X509Certificate[] {
  if (!cachedGoogleRoots) cachedGoogleRoots = loadGoogleRoots();
  return cachedGoogleRoots;
}

export interface AttestationVerificationResult {
  ok: boolean;
  reason?: string;
}

/** Extracts the raw attestationChallenge bytes from a leaf certificate's Android
 * Key Attestation extension, or null if the extension isn't present or doesn't
 * parse as expected. Uses pkijs's schema-aware Certificate parser for the X.509
 * extension list -- more robust than hand-walking the ASN.1 tree for a part of
 * the structure this project doesn't otherwise need to touch. */
/** Exported for the enrollment route: it needs the raw challenge bytes to look
 * up the pending nonce BEFORE full chain verification makes sense to run. */
export function extractAttestationChallenge(leafDer: Uint8Array): Uint8Array | null {
  let cert: Certificate;
  try {
    const asn1 = fromBER(leafDer instanceof Uint8Array ? leafDer.buffer.slice(leafDer.byteOffset, leafDer.byteOffset + leafDer.byteLength) : leafDer);
    if (asn1.offset === -1) return null;
    cert = new Certificate({ schema: asn1.result });
  } catch {
    return null;
  }

  const extension = cert.extensions?.find((ext) => ext.extnID === ANDROID_KEY_ATTESTATION_OID);
  if (!extension) return null;

  try {
    // extnValue is itself DER bytes (an ASN.1 SEQUENCE, KeyDescription) wrapped
    // in an OCTET STRING -- a second, nested BER parse is required.
    const octetString = extension.extnValue as OctetString;
    const innerBytes = octetString.valueBlock.valueHexView;
    const keyDescription = fromBER(innerBytes.buffer.slice(innerBytes.byteOffset, innerBytes.byteOffset + innerBytes.byteLength));
    if (keyDescription.offset === -1) return null;

    const sequence = keyDescription.result as unknown as { valueBlock: { value: unknown[] } };
    const challengeField = sequence.valueBlock.value[ATTESTATION_CHALLENGE_FIELD_INDEX] as OctetString | undefined;
    if (!challengeField) return null;
    return new Uint8Array(challengeField.valueBlock.valueHexView);
  } catch {
    return null;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Verifies an Android Key Attestation certificate chain (leaf first) up to a
 * pinned Google root, and confirms the leaf's attestationChallenge matches the
 * nonce this server issued for the enrollment. Fails closed: any parse error,
 * broken signature link, untrusted root, or challenge mismatch returns
 * `ok: false` -- attestation_ok in the devices table is only ever set from
 * this function's result, never assumed true (spec §2.5).
 *
 * Deliberately scoped down from "verify every attestation extension field":
 * chain validity + challenge match is the MVP gate. Deeper policy
 * (verified-boot state, patch-level freshness, and revocation checking against
 * Google's key-attestation status list -- a revoked key currently passes this
 * gate) is a named, known gap, not required for the M1 exit gate.
 */
export function verifyAttestationChain(
  derChainLeafFirst: Uint8Array[],
  expectedChallenge: Uint8Array,
  // Injectable for tests only -- production callers (M1 Step 8) never pass
  // this and get the real pinned Google roots. Without this seam, tests can
  // only ever prove "everything is rejected", never that a genuinely valid
  // chain is accepted, since no real device chain is available in this
  // environment to test against the actual pinned roots.
  trustedRoots: X509Certificate[] = googleRoots(),
): AttestationVerificationResult {
  if (derChainLeafFirst.length === 0) {
    return { ok: false, reason: "empty attestation chain" };
  }

  let certs: X509Certificate[];
  try {
    certs = derChainLeafFirst.map((der) => new X509Certificate(Buffer.from(der)));
  } catch (e) {
    return { ok: false, reason: `malformed certificate: ${(e as Error).message}` };
  }

  for (let i = 0; i < certs.length - 1; i++) {
    const subject = certs[i]!;
    const issuer = certs[i + 1]!;
    if (!subject.checkIssued(issuer) || !subject.verify(issuer.publicKey)) {
      return { ok: false, reason: `signature chain broken at index ${i}` };
    }
  }

  const lastInChain = certs[certs.length - 1]!;
  const terminatesAtPinnedRoot = trustedRoots.some((root) => {
    if (root.fingerprint256 === lastInChain.fingerprint256) return true;
    // The device didn't include the root itself, but the last cert it did
    // include is directly issued by a pinned root.
    return lastInChain.checkIssued(root) && lastInChain.verify(root.publicKey);
  });
  if (!terminatesAtPinnedRoot) {
    return { ok: false, reason: "chain does not terminate at a pinned Google root" };
  }

  const challenge = extractAttestationChallenge(derChainLeafFirst[0]!);
  if (!challenge) {
    return { ok: false, reason: "leaf certificate has no Android Key Attestation extension" };
  }
  if (!constantTimeEqual(challenge, expectedChallenge)) {
    return { ok: false, reason: "attestation challenge does not match the issued enrollment nonce" };
  }

  return { ok: true };
}
