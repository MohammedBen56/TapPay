import { randomUUID } from "node:crypto";
import {
  decodeTxReceipt,
  encodeOfflineIou,
  encodeTxProposal,
  signCoseSign1,
  uuidToBytes,
  verifyCoseSign1,
  type OfflineIou,
  type TxProposal,
} from "@tappay/shared";
import { afterAll, describe, expect, it, vi } from "vitest";
import { bankAdapter } from "../../../adapters/index.js";
import { buildApp } from "../../../app.js";
import { config } from "../../../config.js";
import { serverPublicKeyBytes } from "../../../crypto/serverSigner.js";
import { db } from "../../../db/kysely.js";
import { createEnrolledDevice, type TestDevice } from "./testHelpers.js";

async function buildSignedIou(
  sender: TestDevice,
  recipient: TestDevice,
  amount: bigint,
  seq: bigint,
  opts: { txUuid?: string; ts?: number; currency?: string } = {},
): Promise<{ base64: string; txUuid: string }> {
  const txUuid = opts.txUuid ?? randomUUID();
  const iou: OfflineIou = {
    tx_uuid: uuidToBytes(txUuid),
    sender_device_id: uuidToBytes(sender.deviceId),
    recipient_device_id: uuidToBytes(recipient.deviceId),
    amount,
    currency: opts.currency ?? "MAD",
    seq,
    ts: opts.ts ?? Date.now(),
  };
  const payload = encodeOfflineIou(iou);
  const coseBytes = await signCoseSign1(payload, sender.signer);
  return { base64: Buffer.from(coseBytes).toString("base64"), txUuid };
}

describe("/tx/sync", () => {
  const app = buildApp({ rateLimit: false, proximityRoutes: true });

  async function getFreshnessToken(deviceId: string): Promise<string> {
    const res = await app.inject({ method: "GET", url: `/devices/${deviceId}/freshness-token` });
    expect(res.statusCode).toBe(200);
    return res.json().token as string;
  }

  it("happy path: one Mode C intent settles, journal is sum-to-zero, last_seq advances", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const token = await getFreshnessToken(alice.deviceId);
    const { base64, txUuid } = await buildSignedIou(alice, bob, 2_500n, 1n);

    const response = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: base64, freshness_token: token }] },
    });

    expect(response.statusCode).toBe(200);
    const [result] = response.json().results;
    expect(result.status).toBe("SETTLED");
    expect(result.receipt).toBeTypeOf("string");

    const journalRows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(journalRows.reduce((sum, row) => sum + BigInt(row.amount), 0n)).toBe(0n);

    const deviceRow = await db
      .selectFrom("devices")
      .select("last_seq")
      .where("device_id", "=", Buffer.from(uuidToBytes(alice.deviceId)))
      .executeTakeFirstOrThrow();
    expect(deviceRow.last_seq).toBe(1n);
  });

  it("rejects a self-payment (sender and recipient resolve to the same account): reported, never admitted, last_seq untouched", async () => {
    const alice = await createEnrolledDevice(10_000n);
    const token = await getFreshnessToken(alice.deviceId);
    const { base64, txUuid } = await buildSignedIou(alice, alice, 1_000n, 1n);

    const response = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: base64, freshness_token: token }] },
    });

    expect(response.statusCode).toBe(200);
    const [result] = response.json().results;
    expect(result.status).toBe("FAILED_SELF_PAYMENT");

    const intentRows = await db.selectFrom("offline_intents").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(intentRows).toHaveLength(0);

    const deviceRow = await db
      .selectFrom("devices")
      .select("last_seq")
      .where("device_id", "=", Buffer.from(uuidToBytes(alice.deviceId)))
      .executeTakeFirstOrThrow();
    expect(deviceRow.last_seq).toBe(0n);
  });

  it("insufficient balance -> FAILED_INSUFFICIENT, no journal write, last_seq still advances", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(100n), createEnrolledDevice(0n)]);
    const token = await getFreshnessToken(alice.deviceId);
    const { base64, txUuid } = await buildSignedIou(alice, bob, 1_000n, 1n);

    const response = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: base64, freshness_token: token }] },
    });

    expect(response.json().results[0].status).toBe("FAILED_INSUFFICIENT");
    const journalRows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(journalRows).toHaveLength(0);

    const deviceRow = await db
      .selectFrom("devices")
      .select("last_seq")
      .where("device_id", "=", Buffer.from(uuidToBytes(alice.deviceId)))
      .executeTakeFirstOrThrow();
    expect(deviceRow.last_seq).toBe(1n);
  });

  it("expired freshness token -> FAILED_EXPIRED, no journal write, last_seq still advances", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const token = await getFreshnessToken(alice.deviceId);
    // IOU's own ts is far enough past "now" (when the token was issued) to bust
    // the 24h freshness window -- simulates a device that fetched a token, then
    // stayed offline well past its validity before finally signing/sending.
    const staleTs = Date.now() + config.offlineFreshnessTokenTtlMs + 60_000;
    const { base64, txUuid } = await buildSignedIou(alice, bob, 500n, 1n, { ts: staleTs });

    const response = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: base64, freshness_token: token }] },
    });

    expect(response.json().results[0].status).toBe("FAILED_EXPIRED");
    const journalRows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(journalRows).toHaveLength(0);

    const deviceRow = await db
      .selectFrom("devices")
      .select("last_seq")
      .where("device_id", "=", Buffer.from(uuidToBytes(alice.deviceId)))
      .executeTakeFirstOrThrow();
    expect(deviceRow.last_seq).toBe(1n);
  });

  it("ADV-03: a replayed/rolled-back seq is rejected and the device is flagged", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const token = await getFreshnessToken(alice.deviceId);

    const first = await buildSignedIou(alice, bob, 1_000n, 1n);
    const firstRes = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: first.base64, freshness_token: token }] },
    });
    expect(firstRes.json().results[0].status).toBe("SETTLED");

    // A different tx_uuid, same seq=1 -- simulates restoring a local SQLite
    // snapshot from before the first send and signing a new spend at the same
    // sequence slot.
    const replay = await buildSignedIou(alice, bob, 1_000n, 1n);
    const replayRes = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: replay.base64, freshness_token: token }] },
    });

    expect(replayRes.json().results[0].status).toBe("FAILED_SEQUENCE_REGRESSION");
    const journalRows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", replay.txUuid).execute();
    expect(journalRows).toHaveLength(0);

    const deviceRow = await db
      .selectFrom("devices")
      .select(["last_seq", "rollback_flagged_at"])
      .where("device_id", "=", Buffer.from(uuidToBytes(alice.deviceId)))
      .executeTakeFirstOrThrow();
    expect(deviceRow.last_seq).toBe(1n); // unchanged by the rejected replay
    expect(deviceRow.rollback_flagged_at).not.toBeNull();
  });

  it("idempotent resync: resubmitting an already-settled tx_uuid returns the same receipt, no double journal write", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const token = await getFreshnessToken(alice.deviceId);
    const { base64, txUuid } = await buildSignedIou(alice, bob, 1_000n, 1n);

    const first = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: base64, freshness_token: token }] },
    });
    const second = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: base64, freshness_token: token }] },
    });

    expect(first.json().results[0].status).toBe("SETTLED");
    expect(second.json().results[0].status).toBe("SETTLED");
    expect(second.json().results[0].receipt).toBe(first.json().results[0].receipt);

    const journalRows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(journalRows).toHaveLength(2); // one debit + one credit, not four
  });

  it("processes a mixed batch (valid, insufficient funds, replayed) independently and in order", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(1_500n), createEnrolledDevice(0n)]);
    const token = await getFreshnessToken(alice.deviceId);

    const ok = await buildSignedIou(alice, bob, 1_000n, 1n);
    const shortfall = await buildSignedIou(alice, bob, 1_000n, 2n); // only 500 left after `ok` settles
    const replay = await buildSignedIou(alice, bob, 100n, 1n); // reuses seq=1

    const response = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: {
        device_id: alice.deviceId,
        intents: [
          { cose_iou: ok.base64, freshness_token: token },
          { cose_iou: shortfall.base64, freshness_token: token },
          { cose_iou: replay.base64, freshness_token: token },
        ],
      },
    });

    const statuses = response.json().results.map((r: { status: string }) => r.status);
    expect(statuses).toEqual(["SETTLED", "FAILED_INSUFFICIENT", "FAILED_SEQUENCE_REGRESSION"]);
  });

  it("security fix: a different device's IOU cannot hijack an existing tx_uuid's PENDING settlement slot", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const mallory = await createEnrolledDevice(10_000n);

    // Simulate a crash-recovery scenario: alice's admission already committed
    // a PENDING row for her real signed intent, as if her sync connection
    // dropped right before settlement.
    const { base64: aliceBase64, txUuid } = await buildSignedIou(alice, bob, 1_000n, 1n);
    const [aliceUser, bobUser] = await Promise.all([
      db.selectFrom("devices").select("user_id").where("device_id", "=", Buffer.from(uuidToBytes(alice.deviceId))).executeTakeFirstOrThrow(),
      db.selectFrom("devices").select("user_id").where("device_id", "=", Buffer.from(uuidToBytes(bob.deviceId))).executeTakeFirstOrThrow(),
    ]);
    await db
      .insertInto("offline_intents")
      .values({
        tx_uuid: txUuid,
        sender_id: aliceUser.user_id,
        receiver_id: bobUser.user_id,
        amount: 1_000n,
        currency: "MAD",
        cose_proposal: Buffer.from(aliceBase64, "base64"),
        status: "PENDING",
      })
      .execute();

    // Mallory is a different, unrelated device -- she learned alice's tx_uuid
    // some other way (e.g. as the intended recipient of a different Mode C
    // payment's informational relay) and signs her OWN IOU reusing it.
    const mallowToken = await getFreshnessToken(mallory.deviceId);
    const forged = await buildSignedIou(mallory, bob, 1_000n, 1n, { txUuid });

    const response = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: mallory.deviceId, intents: [{ cose_iou: forged.base64, freshness_token: mallowToken }] },
    });

    expect(response.json().results[0].status).toBe("FAILED_INVALID_SIGNATURE");
    const journalRows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(journalRows).toHaveLength(0); // mallory's transfer never executed
    const row = await db.selectFrom("offline_intents").select("status").where("tx_uuid", "=", txUuid).executeTakeFirstOrThrow();
    expect(row.status).toBe("PENDING"); // untouched -- alice's real intent can still resume later
  });

  it("rejects a batch larger than the configured max intents per request", async () => {
    const alice = await createEnrolledDevice(10_000n);
    const token = await getFreshnessToken(alice.deviceId);
    const oversized = { device_id: alice.deviceId, intents: Array.from({ length: config.syncMaxIntentsPerBatch + 1 }, () => ({ cose_iou: "x", freshness_token: token })) };

    const response = await app.inject({ method: "POST", url: "/tx/sync", payload: oversized });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("InvalidRequest");
  });

  it("rejects an IOU addressed to an unenrolled recipient as FAILED_UNKNOWN_RECIPIENT, reported not persisted", async () => {
    const alice = await createEnrolledDevice(10_000n);
    const token = await getFreshnessToken(alice.deviceId);
    // A recipient device_id that was never enrolled -- not expected in
    // practice (the recipient's own request QR is what carries this id), but
    // a real blind spot: offline_intents.receiver_id is NOT NULL / FK'd, so
    // this can never be admitted as a durable row.
    // recipient.signer is never read by buildSignedIou (only the sender signs
    // the IOU) -- alice's signer is reused here purely to satisfy the type,
    // avoiding an extra throwaway createEnrolledDevice call.
    const ghostRecipient: TestDevice = { deviceId: randomUUID(), accountId: "", signer: alice.signer };
    const { base64, txUuid } = await buildSignedIou(alice, ghostRecipient, 100n, 1n);

    const response = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: base64, freshness_token: token }] },
    });

    expect(response.json().results[0].status).toBe("FAILED_UNKNOWN_RECIPIENT");
    const intentRows = await db.selectFrom("offline_intents").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(intentRows).toHaveLength(0);
    const deviceRow = await db
      .selectFrom("devices")
      .select("last_seq")
      .where("device_id", "=", Buffer.from(uuidToBytes(alice.deviceId)))
      .executeTakeFirstOrThrow();
    expect(deviceRow.last_seq).toBe(0n); // never admitted -- same posture as FAILED_SELF_PAYMENT
  });

  it("rejects a non-positive amount as FAILED_INVALID_AMOUNT, reported not persisted, without failing the rest of the batch", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const token = await getFreshnessToken(alice.deviceId);
    const bad = await buildSignedIou(alice, bob, 0n, 1n);
    const ok = await buildSignedIou(alice, bob, 100n, 2n);

    const response = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: {
        device_id: alice.deviceId,
        intents: [
          { cose_iou: bad.base64, freshness_token: token },
          { cose_iou: ok.base64, freshness_token: token },
        ],
      },
    });

    const statuses = response.json().results.map((r: { status: string }) => r.status);
    expect(statuses).toEqual(["FAILED_INVALID_AMOUNT", "SETTLED"]);
    const intentRows = await db.selectFrom("offline_intents").selectAll().where("tx_uuid", "=", bad.txUuid).execute();
    expect(intentRows).toHaveLength(0); // never admitted -- response-only, same posture as FAILED_SELF_PAYMENT
  });

  it("a Mode C receipt names the recipient device with a zero receiver_nonce", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const token = await getFreshnessToken(alice.deviceId);
    const { base64 } = await buildSignedIou(alice, bob, 750n, 1n);

    const response = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: base64, freshness_token: token }] },
    });

    expect(response.json().results[0].status).toBe("SETTLED");
    const verified = verifyCoseSign1(Buffer.from(response.json().results[0].receipt, "base64"), serverPublicKeyBytes)!;
    const receipt = decodeTxReceipt(verified.payload);
    expect(Array.from(receipt.recipient_device_id)).toEqual(Array.from(uuidToBytes(bob.deviceId)));
    expect(Array.from(receipt.receiver_nonce)).toEqual(Array.from(new Uint8Array(16)));
  });

  it("a Mode C IOU cannot hijack a tx_uuid already settled via /tx/submit (cross-mode case)", async () => {
    // The sync.ts guard above keys on offline_intents, which has no row for a
    // tx_uuid that settled through /tx/submit -- this is the case only the
    // transfer()-level guard closes.
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const txUuid = randomUUID();
    const proposal: TxProposal = {
      tx_uuid: uuidToBytes(txUuid),
      sender_device_id: uuidToBytes(alice.deviceId),
      recipient_device_id: uuidToBytes(bob.deviceId),
      amount: 1_000n,
      currency: "MAD",
      receiver_nonce: uuidToBytes(randomUUID()),
      ts: Date.now(),
    };
    const proposalCose = await signCoseSign1(encodeTxProposal(proposal), alice.signer);
    const submitRes = await app.inject({
      method: "POST",
      url: "/tx/submit",
      payload: { cose_sign1: Buffer.from(proposalCose).toString("base64") },
    });
    expect(submitRes.statusCode).toBe(200);

    const mallory = await createEnrolledDevice(10_000n);
    const mallowToken = await getFreshnessToken(mallory.deviceId);
    const forged = await buildSignedIou(mallory, bob, 1_000n, 1n, { txUuid });

    const response = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: mallory.deviceId, intents: [{ cose_iou: forged.base64, freshness_token: mallowToken }] },
    });

    expect(response.json().results[0].status).toBe("FAILED_CONFLICT");
    expect(response.json().results[0].receipt).toBeUndefined();
    const journalRows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(journalRows).toHaveLength(2); // still just alice/bob's original pair
  });

  it("a bank-adapter fault after admission leaves the intent PENDING (not FAILED_*, not a 500), and resubmitting the byte-identical intent afterward resumes and settles", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const token = await getFreshnessToken(alice.deviceId);
    const { base64, txUuid } = await buildSignedIou(alice, bob, 1_000n, 1n);

    // Overrides only the next call -- admission (its own, separate, already-
    // committed transaction) is untouched; only the settlement transfer()
    // call faults.
    const transferSpy = vi.spyOn(bankAdapter, "transfer").mockRejectedValueOnce(new Error("simulated bank fault"));

    const first = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: base64, freshness_token: token }] },
    });

    expect(first.statusCode).toBe(200); // the fault must not abort the batch as an unhandled 500
    expect(first.json().results[0].status).toBe("PENDING");
    expect(first.json().results[0].receipt).toBeUndefined();

    const deviceRow = await db
      .selectFrom("devices")
      .select("last_seq")
      .where("device_id", "=", Buffer.from(uuidToBytes(alice.deviceId)))
      .executeTakeFirstOrThrow();
    expect(deviceRow.last_seq).toBe(1n); // admission's transaction had already committed before the fault

    const intentRow = await db.selectFrom("offline_intents").select("status").where("tx_uuid", "=", txUuid).executeTakeFirstOrThrow();
    expect(intentRow.status).toBe("PENDING"); // never written FAILED_* for a transport-level fault, not this device's own failure

    // The spy's mockRejectedValueOnce only overrides the one call above --
    // this resubmission of the byte-identical intent hits the real adapter.
    const second = await app.inject({
      method: "POST",
      url: "/tx/sync",
      payload: { device_id: alice.deviceId, intents: [{ cose_iou: base64, freshness_token: token }] },
    });

    expect(second.json().results[0].status).toBe("SETTLED");
    expect(second.json().results[0].receipt).toBeTypeOf("string");
    const journalRows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(journalRows).toHaveLength(2); // settled exactly once, not doubled by the resume

    transferSpy.mockRestore();
  });

  it("freshness-token endpoint returns 403 for a device whose attestation was never verified", async () => {
    const alice = await createEnrolledDevice(0n);
    await db
      .updateTable("devices")
      .set({ attestation_ok: false })
      .where("device_id", "=", Buffer.from(uuidToBytes(alice.deviceId)))
      .execute();

    const response = await app.inject({ method: "GET", url: `/devices/${alice.deviceId}/freshness-token` });
    expect(response.statusCode).toBe(403);
  });
});

afterAll(async () => {
  await db.destroy();
});
