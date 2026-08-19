import { randomUUID } from "node:crypto";
import { encodeOfflineIou, signCoseSign1, uuidToBytes, type OfflineIou } from "@tappay/shared";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { config } from "../../config.js";
import { db } from "../../db/kysely.js";
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
  const app = buildApp();

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
