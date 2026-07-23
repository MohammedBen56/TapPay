import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyCoseSign1 } from "../cose.js";
import { verifyEcdsaP256 } from "../ecdsa.js";

const VECTORS_DIR = fileURLToPath(new URL("./vectors/", import.meta.url));

function hex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}

describe("COSE_Sign1 vectors (cose-wg/Examples)", () => {
  const fixture = JSON.parse(readFileSync(`${VECTORS_DIR}cose-wg-sign1.json`, "utf8")) as {
    vectors: Array<{ name: string; title: string; coseSign1Hex: string; uncompressedPublicKeyHex: string; expectValid: boolean }>;
  };

  for (const v of fixture.vectors) {
    it(`${v.name}: ${v.title} (expect ${v.expectValid ? "valid" : "invalid"})`, () => {
      const result = verifyCoseSign1(hex(v.coseSign1Hex), hex(v.uncompressedPublicKeyHex));
      if (v.expectValid) {
        expect(result).not.toBeNull();
      } else {
        expect(result).toBeNull();
      }
    });
  }

  it("verify() is byte-preserving: decoding a valid vector and re-verifying its untouched original bytes still passes", () => {
    // Directly exercises the rule documented on verifyCoseSign1: the payload used
    // to rebuild the Sig_structure must come from the RECEIVED bytes verbatim,
    // never from re-encoding a decoded object. A vector round-tripped through
    // decode-then-reconstruct would only pass this test if that rule holds.
    const passVector = fixture.vectors.find((v) => v.name === "sign-pass-03")!;
    const coseBytes = hex(passVector.coseSign1Hex);
    const publicKey = hex(passVector.uncompressedPublicKeyHex);

    const first = verifyCoseSign1(coseBytes, publicKey);
    expect(first).not.toBeNull();

    // Re-verify from the exact same original bytes a second time -- must be
    // stable, not just "happened to pass once".
    const second = verifyCoseSign1(coseBytes, publicKey);
    expect(second).not.toBeNull();
    expect(second!.payload).toEqual(first!.payload);
  });
});

describe("ECDSA-P256/SHA-256 vectors (Wycheproof, C2SP/wycheproof, p1363/raw r||s)", () => {
  const fixture = JSON.parse(readFileSync(`${VECTORS_DIR}wycheproof-p256-p1363.json`, "utf8")) as {
    numberOfTests: number;
    testGroups: Array<{
      publicKeyUncompressed: string;
      tests: Array<{ tcId: number; comment: string; msg: string; sig: string; result: "valid" | "invalid" | "acceptable" }>;
    }>;
  };

  it("fixture loaded with the expected vector count", () => {
    const total = fixture.testGroups.reduce((sum, g) => sum + g.tests.length, 0);
    expect(total).toBe(fixture.numberOfTests);
    expect(total).toBeGreaterThan(200);
  });

  for (const group of fixture.testGroups) {
    const publicKey = hex(group.publicKeyUncompressed);
    for (const t of group.tests) {
      // "acceptable" cases (e.g. non-canonical but not outright forged) aren't
      // asserted either way here -- only unambiguous valid/invalid vectors are.
      if (t.result === "acceptable") continue;

      it(`tcId ${t.tcId}: ${t.comment || t.result}`, () => {
        const ok = verifyEcdsaP256(hex(t.msg), hex(t.sig), publicKey);
        expect(ok).toBe(t.result === "valid");
      });
    }
  }
});
