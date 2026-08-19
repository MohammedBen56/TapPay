// POST /devices/enroll had zero route-level coverage before this file: every
// other test seeds devices directly (createEnrolledDevice, testHelpers.ts),
// bypassing the actual attestation-chain verification path entirely. The
// blocker was the existing static fixture (attestation/__tests__/fixtures/
// synthetic-chain.json) having a challenge baked in at generation time, which
// can never match a freshly-issued /devices/enroll/nonce -- see
// syntheticChain.ts, a real from-scratch generator that takes the challenge
// as a parameter instead.
//
// Route-level success (attestation_ok: true) additionally requires the
// verified chain to terminate at a TRUSTED root -- and the production route
// always verifies against the REAL pinned Google roots
// (verifyAttestationChain's trustedRoots param has no override in devices.ts,
// unlike verify.test.ts's direct unit-level injection). A synthetic root can
// never be one of those. So each test here points ATTESTATION_GOOGLE_ROOTS_PATH
// at a temp PEM containing our synthetic root, via vi.stubEnv + vi.resetModules
// + a dynamic re-import of app.js -- config.ts reads that env var once at
// module load, and verify.ts's googleRoots() cache is equally fresh per
// import cycle, so this is the one way to exercise the real 200 path without
// a real device.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidToBytes } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../../db/kysely.js";
import { generateSyntheticAttestationChain } from "../../attestation/__tests__/syntheticChain.js";

let openDb: Kysely<Database> | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await openDb?.destroy();
  openDb = undefined;
});

/** Builds a fresh app bound to a temp, test-only ATTESTATION_GOOGLE_ROOTS_PATH
 * -- vi.resetModules() forces config.ts and verify.ts to re-evaluate against
 * the stubbed env var rather than reusing whatever the rest of the suite
 * already cached. Returns the path so the caller can write the actual PEM
 * content (trusted root(s)) into it before the first attestation check runs
 * -- config.ts only stores the path string at import time; the file itself is
 * read lazily, on first verifyAttestationChain call, and cached forever
 * within this one fresh module graph. */
async function freshAppWithSyntheticRoots(): Promise<{ app: FastifyInstance; rootsPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "tappay-synthetic-roots-"));
  const rootsPath = join(dir, "roots.pem");
  vi.resetModules();
  vi.stubEnv("ATTESTATION_GOOGLE_ROOTS_PATH", rootsPath);
  const [{ buildApp }, { db }] = await Promise.all([import("../../../app.js"), import("../../../db/kysely.js")]);
  openDb = db;
  return { app: buildApp({ rateLimit: false, proximityRoutes: true }), rootsPath };
}

async function getNonceChallenge(app: FastifyInstance): Promise<Uint8Array> {
  const res = await app.inject({ method: "GET", url: "/devices/enroll/nonce" });
  expect(res.statusCode).toBe(200);
  const { nonce } = res.json() as { nonce: string };
  return new Uint8Array(Buffer.from(nonce, "base64"));
}

function enrollPayload(deviceId: string, email: string, chain: { identityPubkey: Uint8Array; leafDer: Uint8Array; rootDer: Uint8Array }) {
  return {
    email,
    device_id: deviceId,
    platform: "android" as const,
    identity_pubkey: Buffer.from(chain.identityPubkey).toString("base64"),
    attestation_chain: [Buffer.from(chain.leafDer).toString("base64"), Buffer.from(chain.rootDer).toString("base64")],
  };
}

describe("POST /devices/enroll (real route, synthetic-but-generated chain)", () => {
  it("a genuinely valid chain against a trusted root enrolls successfully -- 200, attestation_ok true, device row persisted", async () => {
    const { app, rootsPath } = await freshAppWithSyntheticRoots();
    const challenge = await getNonceChallenge(app);
    const chain = await generateSyntheticAttestationChain(challenge);
    writeFileSync(rootsPath, chain.rootPem);

    const deviceId = randomUUID();
    const email = `synthetic-${randomUUID()}@tappay.local`;
    const response = await app.inject({ method: "POST", url: "/devices/enroll", payload: enrollPayload(deviceId, email, chain) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ device_id: deviceId, attestation_ok: true });

    const row = await openDb!
      .selectFrom("devices")
      .select(["attestation_ok", "identity_pubkey"])
      .where("device_id", "=", Buffer.from(uuidToBytes(deviceId)))
      .executeTakeFirstOrThrow();
    expect(row.attestation_ok).toBe(true);
    expect(Array.from(row.identity_pubkey)).toEqual(Array.from(chain.identityPubkey));
  });

  it("a chain that doesn't terminate at any trusted root enrolls the device row (audit trail) but reports 403, attestation_ok false", async () => {
    const { app, rootsPath } = await freshAppWithSyntheticRoots();
    // A DIFFERENT, unrelated root written to the trust store than the one
    // that actually signed this chain -- the chain itself is otherwise
    // well-formed (right challenge, right identity_pubkey binding).
    const challenge = await getNonceChallenge(app);
    const chain = await generateSyntheticAttestationChain(challenge);
    const unrelated = await generateSyntheticAttestationChain(new Uint8Array(16));
    writeFileSync(rootsPath, unrelated.rootPem);

    const deviceId = randomUUID();
    const email = `synthetic-${randomUUID()}@tappay.local`;
    const response = await app.inject({ method: "POST", url: "/devices/enroll", payload: enrollPayload(deviceId, email, chain) });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "AttestationFailed", attestation_ok: false });

    const row = await openDb!
      .selectFrom("devices")
      .select(["attestation_ok"])
      .where("device_id", "=", Buffer.from(uuidToBytes(deviceId)))
      .executeTakeFirstOrThrow();
    expect(row.attestation_ok).toBe(false); // stored per spec §2.5, but never trusted
  });

  it("re-enrolling the same device_id under a DIFFERENT identity_pubkey is rejected as a conflict, not merged", async () => {
    const { app, rootsPath } = await freshAppWithSyntheticRoots();
    const challenge1 = await getNonceChallenge(app);
    const chain1 = await generateSyntheticAttestationChain(challenge1);
    writeFileSync(rootsPath, chain1.rootPem);

    const deviceId = randomUUID();
    const email = `synthetic-${randomUUID()}@tappay.local`;
    const first = await app.inject({ method: "POST", url: "/devices/enroll", payload: enrollPayload(deviceId, email, chain1) });
    expect(first.statusCode).toBe(200);

    // A different leaf key (different identity_pubkey), same root (so the
    // chain itself still verifies fine) -- reusing rootKeyPair means this
    // second leaf's signature also verifies against the SAME trusted root
    // public key already written to rootsPath, without needing a second
    // trust-store entry (see verifyAttestationChain's "chain doesn't include
    // the root itself" acceptance path).
    const challenge2 = await getNonceChallenge(app);
    const chain2 = await generateSyntheticAttestationChain(challenge2, { rootKeyPair: chain1.rootKeyPair });

    const second = await app.inject({ method: "POST", url: "/devices/enroll", payload: enrollPayload(deviceId, email, chain2) });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("DeviceAlreadyEnrolled");

    // The original enrollment's identity_pubkey must be untouched -- an
    // upsert here would be an identity-takeover primitive (CLAUDE.md §5).
    const row = await openDb!
      .selectFrom("devices")
      .select(["identity_pubkey"])
      .where("device_id", "=", Buffer.from(uuidToBytes(deviceId)))
      .executeTakeFirstOrThrow();
    expect(Array.from(row.identity_pubkey)).toEqual(Array.from(chain1.identityPubkey));
  });

  it("resubmitting the SAME device_id + identity_pubkey (a dropped-response retry, fresh nonce/chain) is idempotent -- 200, not a conflict", async () => {
    const { app, rootsPath } = await freshAppWithSyntheticRoots();
    const challenge1 = await getNonceChallenge(app);
    const chain1 = await generateSyntheticAttestationChain(challenge1);
    writeFileSync(rootsPath, chain1.rootPem);

    const deviceId = randomUUID();
    const email = `synthetic-${randomUUID()}@tappay.local`;
    const first = await app.inject({ method: "POST", url: "/devices/enroll", payload: enrollPayload(deviceId, email, chain1) });
    expect(first.statusCode).toBe(200);

    // Real-world shape: Android re-attests the SAME KeyStore key (never
    // regenerated) with a NEW server-issued nonce -- same identity_pubkey,
    // different chain bytes/signature.
    const challenge2 = await getNonceChallenge(app);
    const chain2 = await generateSyntheticAttestationChain(challenge2, { rootKeyPair: chain1.rootKeyPair, leafKeyPair: chain1.leafKeyPair });
    expect(chain2.identityPubkey).toEqual(chain1.identityPubkey);

    const second = await app.inject({ method: "POST", url: "/devices/enroll", payload: enrollPayload(deviceId, email, chain2) });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ device_id: deviceId, attestation_ok: true });

    const rows = await openDb!.selectFrom("devices").selectAll().where("device_id", "=", Buffer.from(uuidToBytes(deviceId))).execute();
    expect(rows).toHaveLength(1); // no duplicate row from the retry
  });

  it("rejects a chain with no attestation extension at all (garbage nonce/challenge) as InvalidChallenge, before any DB write", async () => {
    const { app } = await freshAppWithSyntheticRoots();
    // Never fetched a real nonce -- consumeNonce has nothing pending to match.
    const deviceId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/devices/enroll",
      payload: {
        email: `synthetic-${randomUUID()}@tappay.local`,
        device_id: deviceId,
        platform: "android",
        identity_pubkey: Buffer.from(new Uint8Array(33).fill(2)).toString("base64"),
        attestation_chain: [Buffer.from(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01])).toString("base64")], // minimal valid-DER, no extension
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("InvalidChallenge");
    const row = await openDb!
      .selectFrom("devices")
      .select(["device_id"])
      .where("device_id", "=", Buffer.from(uuidToBytes(deviceId)))
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});
