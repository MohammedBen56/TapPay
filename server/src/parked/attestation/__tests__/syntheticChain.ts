import { webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import { AttributeTypeAndValue, BasicConstraints, Certificate, Extension } from "pkijs";

/** Same OID/field-index contract as verify.ts's extractAttestationChallenge --
 * duplicated here (not imported) so this generator stays a pure fixture
 * builder with no dependency on the code under test. */
const ANDROID_KEY_ATTESTATION_OID = "1.3.6.1.4.1.11129.2.1.17";

const subtle = webcrypto.subtle;

/** SEC1-compressed 33-byte P-256 public key from a WebCrypto JWK -- same
 * encoding as compressedPublicKeyFromKeyObject (ecPublicKey.ts), duplicated
 * here because that helper takes a Node KeyObject, not a WebCrypto webcrypto.CryptoKey,
 * and this generator only ever touches WebCrypto keys (what pkijs needs). */
async function compressedPublicKeyFromCryptoKey(publicKey: webcrypto.CryptoKey): Promise<Uint8Array> {
  const jwk = await subtle.exportKey("jwk", publicKey);
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  const yIsOdd = (y[y.length - 1]! & 1) === 1;
  return new Uint8Array(Buffer.concat([Buffer.from([yIsOdd ? 0x03 : 0x02]), x]));
}

function commonName(value: string): AttributeTypeAndValue {
  return new AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.BmpString({ value }) });
}

async function generateP256KeyPair(): Promise<webcrypto.CryptoKeyPair> {
  return subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<webcrypto.CryptoKeyPair>;
}

/** Builds the Android Key Attestation ("KeyDescription") extension value
 * containing `challenge` at field index 4 -- the exact position
 * verify.ts's ATTESTATION_CHALLENGE_FIELD_INDEX reads. The surrounding
 * fields (attestationVersion/securityLevel/keymasterVersion/securityLevel)
 * are placeholder-shaped (real ASN.1 types, fake values) since verify.ts
 * deliberately never reads them (see its doc comment on scope). */
function buildKeyDescriptionExtensionValue(challenge: Uint8Array): ArrayBuffer {
  const sequence = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 3 }), // attestationVersion
      new asn1js.Enumerated({ value: 1 }), // attestationSecurityLevel (TrustedEnvironment)
      new asn1js.Integer({ value: 4 }), // keymasterVersion
      new asn1js.Enumerated({ value: 1 }), // keymasterSecurityLevel
      new asn1js.OctetString({ valueHex: challenge.buffer.slice(challenge.byteOffset, challenge.byteOffset + challenge.byteLength) }),
    ],
  });
  return sequence.toBER(false);
}

export interface SyntheticAttestationChain {
  /** Leaf cert DER, containing the Android Key Attestation extension with
   * `challenge` embedded and a subjectPublicKeyInfo matching identityPubkey. */
  leafDer: Uint8Array;
  /** Self-signed fake root CA DER that issued the leaf -- NOT a real Google
   * root; only trusted by tests that point ATTESTATION_GOOGLE_ROOTS_PATH at
   * it (or inject it directly into verifyAttestationChain's trustedRoots
   * param, as verify.test.ts's static fixture already does). */
  rootDer: Uint8Array;
  /** PEM encoding of rootDer, ready to write to a file for
   * ATTESTATION_GOOGLE_ROOTS_PATH-style route-level tests. */
  rootPem: string;
  /** SEC1-compressed P-256 public key of the leaf's own key pair -- submit
   * this as identity_pubkey to match what verifyAttestationChain checks the
   * leaf certificate's subjectPublicKeyInfo against. */
  identityPubkey: Uint8Array;
  /** The actual key pairs used, so a caller can generate a SECOND chain that
   * reuses the same identity (same leaf key -> same identityPubkey) with a
   * fresh challenge -- the real-world "re-enroll an already-enrolled device"
   * shape: Android re-attests the SAME KeyStore key with a NEW nonce, it
   * never regenerates the key itself. */
  rootKeyPair: webcrypto.CryptoKeyPair;
  leafKeyPair: webcrypto.CryptoKeyPair;
}

function derToPem(der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** Generates a fresh, from-scratch synthetic (not real Android hardware)
 * attestation-shaped chain: a self-signed fake root CA plus a leaf it
 * issued, carrying a real-shaped Android Key Attestation extension with
 * `challenge` embedded at the field index verify.ts actually reads.
 *
 * Unlike the static fixture (fixtures/synthetic-chain.json), the challenge
 * here is a PARAMETER -- this is what makes route-level enrollment tests
 * possible at all: /devices/enroll/nonce issues a fresh, unpredictable nonce
 * per request, which a static fixture's baked-in challenge can never match.
 */
export async function generateSyntheticAttestationChain(
  challenge: Uint8Array,
  options: { rootKeyPair?: webcrypto.CryptoKeyPair; leafKeyPair?: webcrypto.CryptoKeyPair } = {},
): Promise<SyntheticAttestationChain> {
  const rootKeyPair = options.rootKeyPair ?? (await generateP256KeyPair());
  const leafKeyPair = options.leafKeyPair ?? (await generateP256KeyPair());

  const rootCert = new Certificate();
  rootCert.version = 2; // v3 -- required for extensions to be valid
  rootCert.serialNumber = new asn1js.Integer({ value: 1 });
  rootCert.issuer.typesAndValues.push(commonName("TapPay Synthetic Test Root (NOT a real Google root)"));
  rootCert.subject.typesAndValues.push(commonName("TapPay Synthetic Test Root (NOT a real Google root)"));
  rootCert.notBefore.value = new Date();
  const rootNotAfter = new Date();
  rootNotAfter.setUTCFullYear(rootNotAfter.getUTCFullYear() + 1);
  rootCert.notAfter.value = rootNotAfter;
  await rootCert.subjectPublicKeyInfo.importKey(rootKeyPair.publicKey);
  const basicConstraints = new BasicConstraints({ cA: true });
  rootCert.extensions = [
    new Extension({ extnID: "2.5.29.19", critical: true, extnValue: basicConstraints.toSchema().toBER(false), parsedValue: basicConstraints }),
  ];
  await rootCert.sign(rootKeyPair.privateKey, "SHA-256");

  const leafCert = new Certificate();
  leafCert.version = 2;
  leafCert.serialNumber = new asn1js.Integer({ value: 2 });
  leafCert.issuer.typesAndValues.push(commonName("TapPay Synthetic Test Root (NOT a real Google root)"));
  leafCert.subject.typesAndValues.push(commonName("TapPay Synthetic Test Leaf"));
  leafCert.notBefore.value = new Date();
  const leafNotAfter = new Date();
  leafNotAfter.setUTCFullYear(leafNotAfter.getUTCFullYear() + 1);
  leafCert.notAfter.value = leafNotAfter;
  await leafCert.subjectPublicKeyInfo.importKey(leafKeyPair.publicKey);
  leafCert.extensions = [
    new Extension({ extnID: ANDROID_KEY_ATTESTATION_OID, critical: false, extnValue: buildKeyDescriptionExtensionValue(challenge) }),
  ];
  await leafCert.sign(rootKeyPair.privateKey, "SHA-256");

  const rootDer = new Uint8Array(rootCert.toSchema().toBER());
  const leafDer = new Uint8Array(leafCert.toSchema().toBER());
  const identityPubkey = await compressedPublicKeyFromCryptoKey(leafKeyPair.publicKey);

  return { leafDer, rootDer, rootPem: derToPem(rootDer.buffer as ArrayBuffer), identityPubkey, rootKeyPair, leafKeyPair };
}
