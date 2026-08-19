import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compressedPublicKeyFromKeyObject } from "../../../crypto/ecPublicKey.js";
import { verifyAttestationChain } from "../verify.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

function b64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

const fixture = JSON.parse(readFileSync(`${FIXTURES_DIR}synthetic-chain.json`, "utf8")) as {
  leafCertDerBase64: string;
  rootCertDerBase64: string;
  attestationChallengeUtf8: string;
};
const leafDer = b64(fixture.leafCertDerBase64);
const rootDer = b64(fixture.rootCertDerBase64);
const realChallenge = new TextEncoder().encode(fixture.attestationChallengeUtf8);

const fakeRoot = new X509Certificate(Buffer.from(rootDer));
const leafCert = new X509Certificate(Buffer.from(leafDer));
const matchingIdentityPubkey = compressedPublicKeyFromKeyObject(leafCert.publicKey);
const wrongIdentityPubkey = new Uint8Array(matchingIdentityPubkey).fill(0xaa);

// A real device chain (captured once from an actual enrolled phone, M1 Step 6)
// is still needed to confirm end-to-end interop with genuine Android
// attestation output against the REAL pinned google-roots.pem -- not
// simulable without hardware; see the plan's "what needs you" section. These
// tests use the trustedRoots injection seam to still prove the full
// parsing/chain-walking/challenge-matching pipeline genuinely works, not just
// that everything is rejected for the same reason.
describe("verifyAttestationChain (synthetic fixture -- see file header)", () => {
  it("accepts a well-formed chain against its actual (injected) trusted root, with a matching challenge and matching identity_pubkey", () => {
    const result = verifyAttestationChain([leafDer, rootDer], realChallenge, matchingIdentityPubkey, [fakeRoot]);
    expect(result).toEqual({ ok: true });
  });

  it("accepts the same chain even when the root itself isn't included, as long as the last cert is directly issued by a trusted root", () => {
    const result = verifyAttestationChain([leafDer], realChallenge, matchingIdentityPubkey, [fakeRoot]);
    expect(result).toEqual({ ok: true });
  });

  it("rejects a genuinely mismatched challenge even against a trusted root", () => {
    const wrongChallenge = new TextEncoder().encode("not-the-real-challenge");
    const result = verifyAttestationChain([leafDer, rootDer], wrongChallenge, matchingIdentityPubkey, [fakeRoot]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/challenge/);
  });

  it("rejects a well-formed chain against the REAL pinned Google roots (this fixture is not a real device)", () => {
    const result = verifyAttestationChain([leafDer, rootDer], realChallenge, matchingIdentityPubkey);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/pinned Google root/);
  });

  it("rejects an empty chain", () => {
    const result = verifyAttestationChain([], realChallenge, matchingIdentityPubkey, [fakeRoot]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  it("rejects a chain with a broken signature link (unrelated cert substituted)", () => {
    // Reuse the leaf as its own "issuer" -- checkIssued/verify must fail since
    // the leaf never signed itself as a CA would.
    const result = verifyAttestationChain([leafDer, leafDer], realChallenge, matchingIdentityPubkey, [fakeRoot]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/signature chain broken/);
  });

  it("rejects garbage bytes instead of a real certificate", () => {
    const result = verifyAttestationChain(
      [new Uint8Array([1, 2, 3, 4]), rootDer],
      realChallenge,
      matchingIdentityPubkey,
      [fakeRoot],
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/malformed certificate/);
  });

  it("rejects when no roots are trusted at all", () => {
    const result = verifyAttestationChain([leafDer], realChallenge, matchingIdentityPubkey, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/pinned Google root/);
  });

  it("rejects a well-formed, challenge-matching chain when identity_pubkey doesn't match the leaf certificate's own key (the substitution attack this check exists to block)", () => {
    const result = verifyAttestationChain([leafDer, rootDer], realChallenge, wrongIdentityPubkey, [fakeRoot]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/identity_pubkey/);
  });
});
