import { generateKeyPairSync, randomUUID, sign as nodeSign } from "node:crypto";
import { encodeTxProposal, signCoseSign1, uuidToBytes, type Signer, type TxProposal } from "@tappay/shared";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { config } from "../../config.js";
import { compressedPublicKeyFromKeyObject } from "../../crypto/ecPublicKey.js";
import { db, MINT_ACCOUNT_ID } from "../../db/kysely.js";

interface TestDevice {
  deviceId: string;
  accountId: string;
  signer: Signer;
}

// Devices are seeded directly with attestation_ok: true, bypassing the real
// /devices/enroll flow -- Step 7's tests already cover attestation
// verification correctness; these tests are specifically about /tx/submit's
// own responsibilities (signature verification, freshness, transfer,
// idempotency), and no real Android attestation chain is available in this
// environment to exercise the full enroll -> submit pipeline end-to-end.
async function createEnrolledDevice(startingBalance: bigint): Promise<TestDevice> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const compressedPublicKey = compressedPublicKeyFromKeyObject(publicKey);
  const deviceId = randomUUID();
  const accountId = randomUUID();
  const userId = randomUUID();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("accounts")
      .values({ account_id: accountId, user_id: userId, email: `test-${randomUUID()}@tappay.local`, currency: "MAD" })
      .execute();
    await trx
      .insertInto("devices")
      .values({
        device_id: Buffer.from(uuidToBytes(deviceId)),
        user_id: userId,
        identity_pubkey: Buffer.from(compressedPublicKey),
        platform: "android",
        attestation_blob: JSON.stringify({ test: true }),
        attestation_ok: true,
      })
      .execute();
    if (startingBalance > 0n) {
      const txUuid = randomUUID();
      await trx
        .insertInto("journal")
        .values([
          { tx_uuid: txUuid, account_id: MINT_ACCOUNT_ID, amount: -startingBalance, currency: "MAD" },
          { tx_uuid: txUuid, account_id: accountId, amount: startingBalance, currency: "MAD" },
        ])
        .execute();
    }
  });

  const signer: Signer = async (bytesToSign) =>
    new Uint8Array(nodeSign("sha256", bytesToSign, { key: privateKey, dsaEncoding: "ieee-p1363" }));

  return { deviceId, accountId, signer };
}

async function buildSignedProposal(
  sender: TestDevice,
  recipient: TestDevice,
  amount: bigint,
  opts: { txUuid?: string; ts?: number; currency?: string } = {},
): Promise<{ base64: string; txUuid: string }> {
  const txUuid = opts.txUuid ?? randomUUID();
  const proposal: TxProposal = {
    tx_uuid: uuidToBytes(txUuid),
    sender_device_id: uuidToBytes(sender.deviceId),
    recipient_device_id: uuidToBytes(recipient.deviceId),
    amount,
    currency: opts.currency ?? "MAD",
    receiver_nonce: uuidToBytes(randomUUID()),
    ts: opts.ts ?? Date.now(),
  };
  const payload = encodeTxProposal(proposal);
  const coseBytes = await signCoseSign1(payload, sender.signer);
  return { base64: Buffer.from(coseBytes).toString("base64"), txUuid };
}

describe("/tx/submit", () => {
  const app = buildApp();

  it("happy path: a validly signed proposal settles and the receipt is reflected in recipient balance", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const { base64 } = await buildSignedProposal(alice, bob, 2_500n);

    const response = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });

    expect(response.statusCode).toBe(200);
    expect(response.json().receipt).toBeTypeOf("string");

    const balanceRes = await app.inject({ method: "GET", url: `/accounts/${bob.accountId}/balance` });
    expect(balanceRes.json().available_balance).toBe("2500");
  });

  it("ADV-02: tampering the signed bytes invalidates the signature -- rejected, no journal write", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const { base64, txUuid } = await buildSignedProposal(alice, bob, 1_000n);

    const coseBytes = Buffer.from(base64, "base64");
    // Flip a byte roughly in the middle of the structure: protected header (~5
    // bytes) and empty unprotected header (~1 byte) sit at the start, the
    // ~66-byte signature sits at the end, so the midpoint reliably lands inside
    // the payload for a proposal this size.
    coseBytes[Math.floor(coseBytes.length / 2)] ^= 0xff;

    const response = await app.inject({
      method: "POST",
      url: "/tx/submit",
      payload: { cose_sign1: coseBytes.toString("base64") },
    });

    expect(response.statusCode).toBe(403);
    const rows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(rows).toHaveLength(0);
  });

  it("ADV-01: resubmitting the identical proposal returns the exact same receipt, no double-journaling", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const { base64 } = await buildSignedProposal(alice, bob, 1_000n);

    const first = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });
    const second = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().receipt).toBe(first.json().receipt);

    const balanceRes = await app.inject({ method: "GET", url: `/accounts/${alice.accountId}/balance` });
    expect(balanceRes.json().available_balance).toBe("9000"); // debited once, not twice
  });

  it("rejects a proposal from an unenrolled sender device", async () => {
    const [ghost, bob] = await Promise.all([createEnrolledDevice(0n), createEnrolledDevice(0n)]);
    const { base64 } = await buildSignedProposal(ghost, bob, 100n);
    // Remove the device row after signing -- a valid signature from a device
    // the server no longer (or never really) has on record.
    await db.deleteFrom("devices").where("device_id", "=", Buffer.from(uuidToBytes(ghost.deviceId))).execute();

    const response = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a proposal from a device whose attestation was never verified", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    await db
      .updateTable("devices")
      .set({ attestation_ok: false })
      .where("device_id", "=", Buffer.from(uuidToBytes(alice.deviceId)))
      .execute();

    const { base64 } = await buildSignedProposal(alice, bob, 100n);
    const response = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a proposal outside the ts freshness window", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const staleTs = Date.now() - (config.txFreshnessWindowMs + 60_000);
    const { base64 } = await buildSignedProposal(alice, bob, 100n, { ts: staleTs });

    const response = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });
    expect(response.statusCode).toBe(403);
  });

  it("rejects insufficient funds with no journal write", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(100n), createEnrolledDevice(0n)]);
    const { base64, txUuid } = await buildSignedProposal(alice, bob, 1_000n);

    const response = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });
    expect(response.statusCode).toBe(409);
    const rows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(rows).toHaveLength(0);
  });

  it("GET /tx/:txUuid/receipt returns the same receipt as the submit response", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const { base64, txUuid } = await buildSignedProposal(alice, bob, 500n);

    const submitRes = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });
    const receiptRes = await app.inject({ method: "GET", url: `/tx/${txUuid}/receipt` });

    expect(receiptRes.statusCode).toBe(200);
    expect(receiptRes.json().receipt).toBe(submitRes.json().receipt);
  });
});

afterAll(async () => {
  await db.destroy();
});
