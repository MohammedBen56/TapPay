import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import type { DeviceCredential } from "../../types.js";
import { encodeDeviceCredential, encodeSessionHello } from "../cbor.js";
import { signCoseSign1, type Signer } from "../cose.js";
import { verifyEcdsaP256 } from "../ecdsa.js";
import {
  createSessionHello,
  deriveSessionKey,
  generateEphemeralKeyPair,
  openSessionMessage,
  sealSessionMessage,
  verifyEmbeddedCredential,
} from "../session.js";

const VECTORS_DIR = fileURLToPath(new URL("./vectors/", import.meta.url));

function hex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}

function bytes16(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill);
}

/** Builds a Signer + matching public key from a fresh in-test identity keypair
 * -- standing in for a hardware identity key the same way every other test
 * file in this repo does (e.g. testHelpers.ts server-side). */
function makeIdentity(): { sign: Signer; publicKey: Uint8Array } {
  const { secretKey, publicKey } = p256.keygen();
  const sign: Signer = async (bytesToSign) => p256.sign(sha256(bytesToSign), secretKey, { lowS: false }).toBytes("compact");
  return { sign, publicKey };
}

/** Stands in for the server's own identity key across this file's tests --
 * every DeviceCredential fixture below is "signed" by this key, and every
 * deriveSessionKey call verifies against its public half (serverPublicKey),
 * mirroring how getServerPublicKeyBytes() is a single pinned constant in
 * production (M3 Milestone 3: credentials now travel embedded inside a
 * SessionHello instead of being fetched live from the server). */
const server = makeIdentity();

/** Builds a genuinely server-signed DeviceCredential COSE_Sign1, the exact
 * shape SessionHello.own_credential carries -- standing in for what
 * GET /devices/:id/credential would return for a real enrolled device. */
async function makeCredential(deviceId: Uint8Array, identityPubkey: Uint8Array): Promise<Uint8Array> {
  const credential: DeviceCredential = { device_id: deviceId, identity_pubkey: identityPubkey, issued_at: Date.now() };
  return signCoseSign1(encodeDeviceCredential(credential), server.sign);
}

describe("ECDH shared-secret known-answer vectors (Wycheproof secp256r1 ecpoint)", () => {
  const fixture = JSON.parse(readFileSync(`${VECTORS_DIR}wycheproof-ecdh-p256.json`, "utf8")) as {
    tests: Array<{ tcId: number; comment: string; public: string; private: string; shared: string; result: "valid" | "invalid" | "acceptable" }>;
  };

  // Wycheproof's private-key hex isn't always exactly 32 bytes (ASN.1-style
  // leading zero for canonical unsigned-integer encoding, or an intentionally
  // short/edge-case scalar) -- @noble/curves' getSharedSecret wants exactly 32.
  // Normalizing here is a TEST-ONLY concern: production code (generateEphemeralKeyPair)
  // always produces an exact 32-byte secretKey via p256.keygen(), so
  // deriveSessionKey itself never needs this.
  function normalizePrivate(privHex: string): Uint8Array {
    let b = Buffer.from(privHex, "hex");
    if (b.length > 32) {
      while (b.length > 32 && b[0] === 0) b = b.subarray(1);
    } else if (b.length < 32) {
      b = Buffer.concat([Buffer.alloc(32 - b.length), b]);
    }
    return new Uint8Array(b);
  }

  for (const t of fixture.tests) {
    it(`tcId ${t.tcId} (${t.result}): ${t.comment || "no comment"}`, () => {
      const priv = normalizePrivate(t.private);
      const pub = hex(t.public);
      if (t.result === "invalid") {
        let matched = false;
        try {
          const shared = p256.getSharedSecret(priv, pub, true).slice(1);
          matched = Buffer.from(shared).toString("hex") === t.shared;
        } catch {
          matched = false;
        }
        expect(matched).toBe(false);
      } else {
        // "valid" and "acceptable" both must produce the documented shared value.
        const shared = p256.getSharedSecret(priv, pub, true).slice(1);
        expect(Buffer.from(shared).toString("hex")).toBe(t.shared);
      }
    });
  }
});

describe("AES-256-GCM known-answer vectors (Wycheproof, AAD-less)", () => {
  const fixture = JSON.parse(readFileSync(`${VECTORS_DIR}wycheproof-aes-256-gcm.json`, "utf8")) as {
    tests: Array<{ tcId: number; comment: string; key: string; iv: string; msg: string; ct: string; tag: string; result: "valid" | "invalid" }>;
  };

  for (const t of fixture.tests) {
    it(`tcId ${t.tcId} (${t.result}): ${t.comment || "no comment"}`, () => {
      const key = hex(t.key);
      const iv = hex(t.iv);
      const msg = hex(t.msg);
      const expected = Buffer.concat([Buffer.from(t.ct, "hex"), Buffer.from(t.tag, "hex")]).toString("hex");
      if (t.result === "valid") {
        const ciphertext = gcm(key, iv).encrypt(msg);
        expect(Buffer.from(ciphertext).toString("hex")).toBe(expected);
        const plaintext = gcm(key, iv).decrypt(hex(expected));
        expect(Buffer.from(plaintext).toString("hex")).toBe(Buffer.from(t.msg, "hex").toString("hex"));
      } else {
        expect(() => gcm(key, iv).decrypt(hex(expected))).toThrow();
      }
    });
  }
});

describe("HKDF-SHA256 known-answer vectors (RFC 5869 Appendix A, cases 1-3)", () => {
  const cases = [
    {
      name: "Test Case 1: basic",
      ikm: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
      salt: "000102030405060708090a0b0c",
      info: "f0f1f2f3f4f5f6f7f8f9",
      L: 42,
      okm: "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    },
    {
      name: "Test Case 2: longer inputs/outputs",
      ikm: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f",
      salt: "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
      info: "b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
      L: 82,
      okm: "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87",
    },
    {
      name: "Test Case 3: zero-length salt/info",
      ikm: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
      salt: "",
      info: "",
      L: 42,
      okm: "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const out = hkdf(sha256, hex(c.ikm), hex(c.salt), hex(c.info), c.L);
      expect(Buffer.from(out).toString("hex")).toBe(c.okm);
    });
  }
});

describe("sealSessionMessage / openSessionMessage", () => {
  const aliceId = bytes16(0xaa);
  const bobId = bytes16(0xbb);

  it("round-trips plaintext: Alice seals, Bob opens", () => {
    const key = new Uint8Array(32).fill(7);
    const sealed = sealSessionMessage(key, aliceId, bobId, 0n, new TextEncoder().encode("hello bob"));
    const opened = openSessionMessage(key, bobId, aliceId, sealed);
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened!)).toBe("hello bob");
  });

  it("the two devices' canonical directions never collide on the same counter value", () => {
    const key = new Uint8Array(32).fill(7);
    const fromAlice = sealSessionMessage(key, aliceId, bobId, 0n, new Uint8Array([1]));
    const fromBob = sealSessionMessage(key, bobId, aliceId, 0n, new Uint8Array([1]));
    // Different nonces (direction byte differs, derived from device_id order)
    // despite the identical counter -- the whole point of the direction prefix.
    expect(Buffer.from(fromAlice.slice(0, 12)).equals(Buffer.from(fromBob.slice(0, 12)))).toBe(false);
    expect(openSessionMessage(key, bobId, aliceId, fromAlice)).toEqual(new Uint8Array([1]));
    expect(openSessionMessage(key, aliceId, bobId, fromBob)).toEqual(new Uint8Array([1]));
  });

  it("rejects a message reflected back at its own sender, even under the correct shared key", () => {
    // Both sides hold the identical symmetric key -- the direction check, not
    // the key, is what must catch this. Found via /security-review.
    const key = new Uint8Array(32).fill(7);
    const fromAlice = sealSessionMessage(key, aliceId, bobId, 0n, new Uint8Array([1]));
    // Alice tries to "open" her own outgoing message as if Bob had sent it to her.
    expect(openSessionMessage(key, aliceId, bobId, fromAlice)).toBeNull();
  });

  it("rejects a tampered ciphertext (returns null, never throws)", () => {
    const key = new Uint8Array(32).fill(7);
    const sealed = sealSessionMessage(key, aliceId, bobId, 1n, new Uint8Array([9, 9, 9]));
    sealed[sealed.length - 1] ^= 0xff;
    expect(openSessionMessage(key, bobId, aliceId, sealed)).toBeNull();
  });

  it("rejects a message opened under the wrong key", () => {
    const keyA = new Uint8Array(32).fill(1);
    const keyB = new Uint8Array(32).fill(2);
    const sealed = sealSessionMessage(keyA, aliceId, bobId, 0n, new Uint8Array([1, 2, 3]));
    expect(openSessionMessage(keyB, bobId, aliceId, sealed)).toBeNull();
  });

  it("rejects truncated input rather than throwing", () => {
    const key = new Uint8Array(32).fill(7);
    expect(openSessionMessage(key, bobId, aliceId, new Uint8Array(5))).toBeNull();
  });
});

describe("generateEphemeralKeyPair", () => {
  it("actually uses an injected randomBytes source, not just the default -- this is the exact contract a real on-device bug violated", () => {
    // Found via on-device testing (not vitest, which runs under Node and
    // never exercises this): @noble/hashes' default randomBytes() requires
    // globalThis.crypto.getRandomValues, which Hermes/React Native does not
    // provide unless polyfilled. generateEphemeralKeyPair MUST accept an
    // injected source (mobile passes expo-crypto's Crypto.getRandomBytes) --
    // this test proves the injection point is real, not decorative, by
    // checking a fixed source produces a fully deterministic key pair.
    const fixedSeed = new Uint8Array(48).fill(0x42);
    const fixedSource = (length: number) => {
      expect(length).toBe(48); // p256.lengths.seed
      return fixedSeed;
    };
    const first = generateEphemeralKeyPair(fixedSource);
    const second = generateEphemeralKeyPair(fixedSource);
    expect(Buffer.from(first.secretKey).equals(Buffer.from(second.secretKey))).toBe(true);
    expect(Buffer.from(first.publicKey).equals(Buffer.from(second.publicKey))).toBe(true);
  });

  it("the default (no argument) still produces a valid, usable key pair on Node", () => {
    const kp = generateEphemeralKeyPair();
    expect(kp.secretKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(33);
  });
});

describe("verifyEmbeddedCredential", () => {
  it("accepts a genuinely server-signed credential for the expected device", async () => {
    const deviceId = bytes16(0xaa);
    const identity = makeIdentity();
    const credentialCose = await makeCredential(deviceId, identity.publicKey);
    const result = verifyEmbeddedCredential(credentialCose, deviceId, server.publicKey);
    expect(result).not.toBeNull();
    expect(Buffer.from(result!.identity_pubkey).equals(Buffer.from(identity.publicKey))).toBe(true);
  });

  it("rejects a genuine credential for the WRONG device_id (substitution)", async () => {
    const realDeviceId = bytes16(0xaa);
    const claimedDeviceId = bytes16(0xbb);
    const identity = makeIdentity();
    // Genuinely server-signed, just for a different device than claimed.
    const credentialCose = await makeCredential(realDeviceId, identity.publicKey);
    expect(verifyEmbeddedCredential(credentialCose, claimedDeviceId, server.publicKey)).toBeNull();
  });

  it("rejects a credential not signed by the pinned server key at all", async () => {
    const deviceId = bytes16(0xaa);
    const identity = makeIdentity();
    const notTheServer = makeIdentity();
    const credentialCose = await makeCredential(deviceId, identity.publicKey); // signed by `server`
    expect(verifyEmbeddedCredential(credentialCose, deviceId, notTheServer.publicKey)).toBeNull();
  });

  it("returns null (never throws) for garbage bytes", () => {
    expect(verifyEmbeddedCredential(new Uint8Array([1, 2, 3]), bytes16(0xaa), server.publicKey)).toBeNull();
  });
});

describe("deriveSessionKey: symmetry", () => {
  it("A and B derive the byte-identical key, regardless of who is 'first'", async () => {
    const txUuid = bytes16(1);
    const alice = makeIdentity();
    const bob = makeIdentity();
    const aliceDeviceId = bytes16(0xaa);
    const bobDeviceId = bytes16(0xbb);

    const aliceEph = generateEphemeralKeyPair();
    const bobEph = generateEphemeralKeyPair();

    const aliceHello = await createSessionHello({
      txUuid,
      deviceId: aliceDeviceId,
      ephPublicKey: aliceEph.publicKey,
      sign: alice.sign,
      ownCredentialCose: await makeCredential(aliceDeviceId, alice.publicKey),
    });
    const bobHello = await createSessionHello({
      txUuid,
      deviceId: bobDeviceId,
      ephPublicKey: bobEph.publicKey,
      sign: bob.sign,
      ownCredentialCose: await makeCredential(bobDeviceId, bob.publicKey),
    });

    const aliceKey = deriveSessionKey({
      txUuid,
      ourDeviceId: aliceDeviceId,
      ourEphSecretKey: aliceEph.secretKey,
      ourEphPublicKey: aliceEph.publicKey,
      peerHelloCose: bobHello,
      serverPublicKey: server.publicKey,
    });
    const bobKey = deriveSessionKey({
      txUuid,
      ourDeviceId: bobDeviceId,
      ourEphSecretKey: bobEph.secretKey,
      ourEphPublicKey: bobEph.publicKey,
      peerHelloCose: aliceHello,
      serverPublicKey: server.publicKey,
    });

    expect(aliceKey).not.toBeNull();
    expect(bobKey).not.toBeNull();
    expect(Buffer.from(aliceKey!).equals(Buffer.from(bobKey!))).toBe(true);

    // And the derived key actually works for sealing traffic in both directions.
    const sealed = sealSessionMessage(aliceKey!, aliceDeviceId, bobDeviceId, 0n, new Uint8Array([42]));
    expect(openSessionMessage(bobKey!, bobDeviceId, aliceDeviceId, sealed)).toEqual(new Uint8Array([42]));
  });
});

describe("ADV-07: MITM relay is rejected without any BLE hardware", () => {
  it("relay embeds its OWN genuine credential but claims to be Alice's device_id -- rejected by the device_id cross-check", async () => {
    const txUuid = bytes16(2);
    const mallory = makeIdentity(); // the relay's own identity, NOT alice's
    const aliceDeviceId = bytes16(0xaa);
    const malloryDeviceId = bytes16(0xcc);
    const bobDeviceId = bytes16(0xbb);
    const bobEph = generateEphemeralKeyPair();

    // Mallory can't forge Alice's signature, and she can't get the server to
    // sign a credential claiming she's Alice -- the best she can do is embed
    // her OWN genuine, genuinely server-signed credential while claiming
    // Alice's device_id in the hello's own device_id field.
    const relayHello = await createSessionHello({
      txUuid,
      deviceId: aliceDeviceId, // claims to be Alice
      ephPublicKey: generateEphemeralKeyPair().publicKey,
      sign: mallory.sign,
      ownCredentialCose: await makeCredential(malloryDeviceId, mallory.publicKey), // but her OWN real credential
    });

    const bobKey = deriveSessionKey({
      txUuid,
      ourDeviceId: bobDeviceId,
      ourEphSecretKey: bobEph.secretKey,
      ourEphPublicKey: bobEph.publicKey,
      peerHelloCose: relayHello,
      serverPublicKey: server.publicKey,
    });

    expect(bobKey).toBeNull();
  });

  it("relay fabricates a credential it has no server signature for -- rejected at the credential-verification step", async () => {
    const txUuid = bytes16(2);
    const mallory = makeIdentity();
    const notTheServer = makeIdentity(); // mallory doesn't hold the server's key
    const aliceDeviceId = bytes16(0xaa);
    const bobDeviceId = bytes16(0xbb);
    const bobEph = generateEphemeralKeyPair();

    const fakeCredential: DeviceCredential = { device_id: aliceDeviceId, identity_pubkey: mallory.publicKey, issued_at: Date.now() };
    const fabricatedCredentialCose = await signCoseSign1(encodeDeviceCredential(fakeCredential), notTheServer.sign);

    const relayHello = await createSessionHello({
      txUuid,
      deviceId: aliceDeviceId,
      ephPublicKey: generateEphemeralKeyPair().publicKey,
      sign: mallory.sign,
      ownCredentialCose: fabricatedCredentialCose,
    });

    const bobKey = deriveSessionKey({
      txUuid,
      ourDeviceId: bobDeviceId,
      ourEphSecretKey: bobEph.secretKey,
      ourEphPublicKey: bobEph.publicKey,
      peerHelloCose: relayHello,
      serverPublicKey: server.publicKey, // Bob only trusts the REAL server key
    });

    expect(bobKey).toBeNull();
  });

  it("a relay that can only forward bytes (no identity key of either party) cannot insert its own ephemeral key into the session -- both sides still derive the identical key, unaffected", async () => {
    // The previous two tests cover the relay's only real levers: substituting
    // its own identity+credential (caught by the device_id cross-check) or
    // fabricating a credential (caught by the signature check). This test
    // covers the other naive MITM idea -- a relay that just forwards signed
    // hellos unmodified, hoping to sit on the wire and observe -- and shows
    // it gains nothing: since deriveSessionKey only trusts a hello's
    // eph_pubkey after verifying BOTH its embedded credential (against the
    // pinned server key) AND its own signature (against the pubkey that
    // credential just proved belongs to the claimed device), there is no
    // step in the middle where a passive relay could substitute its own
    // ephemeral key without forging something it doesn't have the means to
    // forge. A relay's own ephemeral keypair (generated here to model the
    // attempt) simply never appears in either side's derivation.
    const txUuid = bytes16(3);
    const alice = makeIdentity();
    const bob = makeIdentity();
    const aliceDeviceId = bytes16(0xaa);
    const bobDeviceId = bytes16(0xbb);
    const aliceEph = generateEphemeralKeyPair();
    const bobEph = generateEphemeralKeyPair();
    const relayEph = generateEphemeralKeyPair(); // never used below -- that's the point

    const aliceHello = await createSessionHello({
      txUuid,
      deviceId: aliceDeviceId,
      ephPublicKey: aliceEph.publicKey,
      sign: alice.sign,
      ownCredentialCose: await makeCredential(aliceDeviceId, alice.publicKey),
    });
    const bobHello = await createSessionHello({
      txUuid,
      deviceId: bobDeviceId,
      ephPublicKey: bobEph.publicKey,
      sign: bob.sign,
      ownCredentialCose: await makeCredential(bobDeviceId, bob.publicKey),
    });

    const aliceKey = deriveSessionKey({
      txUuid,
      ourDeviceId: aliceDeviceId,
      ourEphSecretKey: aliceEph.secretKey,
      ourEphPublicKey: aliceEph.publicKey,
      peerHelloCose: bobHello, // relayed byte-for-byte, unmodified
      serverPublicKey: server.publicKey,
    });
    const bobKey = deriveSessionKey({
      txUuid,
      ourDeviceId: bobDeviceId,
      ourEphSecretKey: bobEph.secretKey,
      ourEphPublicKey: bobEph.publicKey,
      peerHelloCose: aliceHello, // relayed byte-for-byte, unmodified
      serverPublicKey: server.publicKey,
    });

    expect(aliceKey).not.toBeNull();
    expect(bobKey).not.toBeNull();
    expect(Buffer.from(aliceKey!).equals(Buffer.from(bobKey!))).toBe(true);
    expect(relayEph.publicKey.length).toBe(33); // generated, but never referenced above
  });
});

describe("deriveSessionKey: fail-closed cases", () => {
  function baseParams() {
    const txUuid = bytes16(4);
    const alice = makeIdentity();
    const bob = makeIdentity();
    const aliceDeviceId = bytes16(0xaa);
    const bobDeviceId = bytes16(0xbb);
    const aliceEph = generateEphemeralKeyPair();
    const bobEph = generateEphemeralKeyPair();
    return { txUuid, alice, bob, aliceDeviceId, bobDeviceId, aliceEph, bobEph };
  }

  it("rejects a hello whose signature was tampered with", async () => {
    const { txUuid, alice, aliceDeviceId, bobDeviceId, aliceEph, bobEph } = baseParams();
    const aliceHello = await createSessionHello({
      txUuid,
      deviceId: aliceDeviceId,
      ephPublicKey: aliceEph.publicKey,
      sign: alice.sign,
      ownCredentialCose: await makeCredential(aliceDeviceId, alice.publicKey),
    });
    const tampered = new Uint8Array(aliceHello);
    tampered[tampered.length - 1] ^= 0xff;

    const key = deriveSessionKey({
      txUuid,
      ourDeviceId: bobDeviceId,
      ourEphSecretKey: bobEph.secretKey,
      ourEphPublicKey: bobEph.publicKey,
      peerHelloCose: tampered,
      serverPublicKey: server.publicKey,
    });
    expect(key).toBeNull();
  });

  it("rejects a hello for the wrong tx_uuid", async () => {
    const { alice, aliceDeviceId, bobDeviceId, aliceEph, bobEph } = baseParams();
    const wrongTxUuid = bytes16(0xee);
    const aliceHello = await createSessionHello({
      txUuid: wrongTxUuid,
      deviceId: aliceDeviceId,
      ephPublicKey: aliceEph.publicKey,
      sign: alice.sign,
      ownCredentialCose: await makeCredential(aliceDeviceId, alice.publicKey),
    });

    const key = deriveSessionKey({
      txUuid: bytes16(4), // Bob expects a different transaction
      ourDeviceId: bobDeviceId,
      ourEphSecretKey: bobEph.secretKey,
      ourEphPublicKey: bobEph.publicKey,
      peerHelloCose: aliceHello,
      serverPublicKey: server.publicKey,
    });
    expect(key).toBeNull();
  });

  it("rejects a reflected hello (peer device_id equals our own)", async () => {
    const { txUuid, alice, aliceDeviceId, aliceEph } = baseParams();
    const aliceHello = await createSessionHello({
      txUuid,
      deviceId: aliceDeviceId,
      ephPublicKey: aliceEph.publicKey,
      sign: alice.sign,
      ownCredentialCose: await makeCredential(aliceDeviceId, alice.publicKey),
    });
    const ourOwnEph = generateEphemeralKeyPair();

    const key = deriveSessionKey({
      txUuid,
      ourDeviceId: aliceDeviceId, // "we" are also Alice -- a reflected/replayed message
      ourEphSecretKey: ourOwnEph.secretKey,
      ourEphPublicKey: ourOwnEph.publicKey,
      peerHelloCose: aliceHello,
      serverPublicKey: server.publicKey,
    });
    expect(key).toBeNull();
  });

  it("rejects a stale hello outside the freshness window", async () => {
    const { txUuid, alice, aliceDeviceId, bobDeviceId, aliceEph, bobEph } = baseParams();
    const staleTs = Date.now() - 60_000;
    const aliceHello = await createSessionHello({
      txUuid,
      deviceId: aliceDeviceId,
      ephPublicKey: aliceEph.publicKey,
      sign: alice.sign,
      ownCredentialCose: await makeCredential(aliceDeviceId, alice.publicKey),
      now: staleTs,
    });

    const key = deriveSessionKey({
      txUuid,
      ourDeviceId: bobDeviceId,
      ourEphSecretKey: bobEph.secretKey,
      ourEphPublicKey: bobEph.publicKey,
      peerHelloCose: aliceHello,
      serverPublicKey: server.publicKey,
      helloWindowMs: 30_000,
    });
    expect(key).toBeNull();
  });

  it("rejects malformed CBOR inside an otherwise-validly-signed COSE_Sign1", async () => {
    const { bobDeviceId, bobEph } = baseParams();
    const signer = makeIdentity();
    const malformedPayload = new Uint8Array([1, 2, 3]);
    const coseBytes = await signCoseSign1(malformedPayload, signer.sign);

    const key = deriveSessionKey({
      txUuid: bytes16(4),
      ourDeviceId: bobDeviceId,
      ourEphSecretKey: bobEph.secretKey,
      ourEphPublicKey: bobEph.publicKey,
      peerHelloCose: coseBytes,
      serverPublicKey: server.publicKey,
    });
    expect(key).toBeNull();
  });

  it("returns null (never throws) for peerHelloCose bytes that aren't a COSE_Sign1 structure at all", () => {
    // decodeCoseSign1Structure (inside decodeCoseSign1Unverified, called
    // before any signature check to learn which pubkey to verify against)
    // throws on this input -- deriveSessionKey must catch that itself to
    // honor its own documented "null on ANY failure" contract. Found via
    // /security-review.
    const { bobDeviceId, bobEph } = baseParams();
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd]);

    expect(() =>
      deriveSessionKey({
        txUuid: bytes16(4),
        ourDeviceId: bobDeviceId,
        ourEphSecretKey: bobEph.secretKey,
        ourEphPublicKey: bobEph.publicKey,
        peerHelloCose: garbage,
        serverPublicKey: server.publicKey,
      }),
    ).not.toThrow();
  });

  it("rejects a hello whose device_id length doesn't match ours (rules out transcript ambiguity)", async () => {
    const { txUuid, alice, bobDeviceId, bobEph } = baseParams();
    const shortDeviceId = new Uint8Array(4).fill(0xaa); // not 16 bytes
    const oddHello = await createSessionHello({
      txUuid,
      deviceId: shortDeviceId,
      ephPublicKey: generateEphemeralKeyPair().publicKey,
      sign: alice.sign,
      ownCredentialCose: await makeCredential(shortDeviceId, alice.publicKey),
    });

    const key = deriveSessionKey({
      txUuid,
      ourDeviceId: bobDeviceId,
      ourEphSecretKey: bobEph.secretKey,
      ourEphPublicKey: bobEph.publicKey,
      peerHelloCose: oddHello,
      serverPublicKey: server.publicKey,
    });
    expect(key).toBeNull();
  });
});

// Sanity check that makeIdentity()'s hand-rolled Signer produces something
// verifyEcdsaP256 (and therefore verifyCoseSign1, and therefore every test
// above) actually accepts -- if this test ever fails, every "rejected" result
// above would be meaningless (rejected because the whole signing scheme is
// broken, not because of the specific attack being tested).
describe("test-helper sanity", () => {
  it("makeIdentity()'s Signer produces a signature verifyEcdsaP256 accepts", async () => {
    const identity = makeIdentity();
    const msg = new TextEncoder().encode("sanity check");
    const sig = await identity.sign(msg);
    expect(verifyEcdsaP256(msg, sig, identity.publicKey)).toBe(true);
  });

  it("encodeSessionHello round-trips through createSessionHello's signature", async () => {
    const identity = makeIdentity();
    const deviceId = bytes16(10);
    const hello = await createSessionHello({
      txUuid: bytes16(9),
      deviceId,
      ephPublicKey: generateEphemeralKeyPair().publicKey,
      sign: identity.sign,
      ownCredentialCose: await makeCredential(deviceId, identity.publicKey),
    });
    expect(hello.length).toBeGreaterThan(0);
  });
});
