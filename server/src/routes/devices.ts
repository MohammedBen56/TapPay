import { randomUUID } from "node:crypto";
import { uuidToBytes } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { consumeNonce, issueNonce } from "../attestation/nonceStore.js";
import { extractAttestationChallenge, verifyAttestationChain } from "../attestation/verify.js";
import { signDeviceCredential, signFreshnessToken } from "../crypto/serverSigner.js";
import { db } from "../db/kysely.js";

const enrollBodySchema = z.object({
  email: z.string().email(),
  device_id: z.string().uuid(),
  platform: z.literal("android"),
  /** Raw 33-byte SEC1-compressed P-256 public key, base64. */
  identity_pubkey: z.string(),
  /** Raw DER certificates, leaf first, each base64. */
  attestation_chain: z.array(z.string()).min(1),
});

export function registerDeviceRoutes(app: FastifyInstance): void {
  app.get("/devices/enroll/nonce", async () => {
    return { nonce: issueNonce() };
  });

  app.post("/devices/enroll", async (request, reply) => {
    const parsed = enrollBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { email, device_id, platform, identity_pubkey, attestation_chain } = parsed.data;

    const attestationChainDer = attestation_chain.map((b64) => new Uint8Array(Buffer.from(b64, "base64")));
    const challenge = extractAttestationChallenge(attestationChainDer[0]!);

    // Nonce freshness/replay defense happens BEFORE the (more expensive) full
    // chain verification: an unrecognized or already-used challenge is
    // rejected outright, same as a broken chain -- fail closed either way.
    if (!challenge || !consumeNonce(challenge)) {
      return reply.status(400).send({
        error: "InvalidChallenge",
        message: "attestation challenge is missing, unrecognized, or already used",
      });
    }

    const deviceIdBytes = Buffer.from(uuidToBytes(device_id));
    const identityPubkeyBytes = Buffer.from(identity_pubkey, "base64");

    const verification = verifyAttestationChain(attestationChainDer, challenge, identityPubkeyBytes);

    const accountId = await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("accounts")
        .select(["account_id", "user_id"])
        .where("email", "=", email)
        .executeTakeFirst();

      const account =
        existing ??
        (await trx
          .insertInto("accounts")
          .values({ account_id: randomUUID(), user_id: randomUUID(), email, currency: "MAD" })
          .returning(["account_id", "user_id"])
          .executeTakeFirstOrThrow());

      await trx
        .insertInto("devices")
        .values({
          device_id: deviceIdBytes,
          user_id: account.user_id,
          identity_pubkey: identityPubkeyBytes,
          platform,
          // Stored either way (spec §2.5) -- never trusted unless attestation_ok.
          attestation_blob: JSON.stringify({ chain: attestation_chain, reason: verification.reason ?? null }),
          attestation_ok: verification.ok,
        })
        .execute();

      return account.account_id;
    });

    // Fail closed: a device row exists either way (audit trail per spec §2.5),
    // but the HTTP response tells the client enrollment did not succeed if
    // attestation didn't verify -- attestation_ok=false rows can never sign a
    // transaction that's trusted (enforced wherever devices.attestation_ok is
    // read, M1 Step 8), but the client shouldn't believe it enrolled either.
    if (!verification.ok) {
      return reply.status(403).send({
        error: "AttestationFailed",
        message: verification.reason,
        account_id: accountId,
        device_id,
        attestation_ok: false,
      });
    }

    return reply.send({ account_id: accountId, device_id, attestation_ok: true });
  });

  // M2: issues a server-signed proof of "this device reached the server at
  // issued_at" -- the precondition spec §5 requires before a Mode C offline send
  // ("payer holds a freshness_token issued within 24h"). Unauthenticated beyond
  // enrollment, same posture as GET /tx/:txUuid/receipt: this token attests
  // recency only, it doesn't authorize spending -- the IOU's own signature does
  // that, verified separately at /tx/sync.
  app.get("/devices/:deviceId/freshness-token", async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const deviceIdParsed = z.string().uuid().safeParse(deviceId);
    if (!deviceIdParsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "deviceId must be a UUID" });
    }

    const deviceIdBytes = Buffer.from(uuidToBytes(deviceId));
    const device = await db
      .selectFrom("devices")
      .select(["attestation_ok"])
      .where("device_id", "=", deviceIdBytes)
      .executeTakeFirst();
    if (!device) {
      return reply.status(404).send({ error: "UnknownDevice", message: "device is not enrolled" });
    }
    if (!device.attestation_ok) {
      // Fail closed, same gate /tx/submit uses: an unverified device gets no
      // proof of recency to build an offline send on top of.
      return reply.status(403).send({ error: "UnverifiedDevice", message: "device attestation was not verified" });
    }

    const token = await signFreshnessToken(deviceIdBytes);
    return reply.send({ token: Buffer.from(token).toString("base64") });
  });

  // Authenticated session ECDH (CLAUDE.md §5) needs each side to verify the
  // peer's ephemeral key against the peer's ENROLLED identity_pubkey --
  // trust-on-first-use would reopen the exact MITM hole authentication closes.
  // findDeviceAccount only reads identity_pubkey server-side; this is the one
  // endpoint that exposes it, and only as a server-signed credential a peer
  // can verify offline against the pinned server key -- never the raw row.
  app.get("/devices/:deviceId/credential", async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const deviceIdParsed = z.string().uuid().safeParse(deviceId);
    if (!deviceIdParsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: "deviceId must be a UUID" });
    }

    const deviceIdBytes = Buffer.from(uuidToBytes(deviceId));
    const device = await db
      .selectFrom("devices")
      .select(["identity_pubkey", "attestation_ok"])
      .where("device_id", "=", deviceIdBytes)
      .executeTakeFirst();
    if (!device) {
      return reply.status(404).send({ error: "UnknownDevice", message: "device is not enrolled" });
    }
    if (!device.attestation_ok) {
      // Fail closed, same gate freshness-token and /tx/submit use: an
      // unverified device's key is never vouched for, so no credential is
      // issued at all -- attestation_ok is deliberately not a field on the
      // credential itself (see DeviceCredential's doc comment), the server
      // simply refuses to sign one.
      return reply.status(403).send({ error: "UnverifiedDevice", message: "device attestation was not verified" });
    }

    const credential = await signDeviceCredential(deviceIdBytes, new Uint8Array(device.identity_pubkey));
    return reply.send({ credential: Buffer.from(credential).toString("base64") });
  });
}
