import { randomUUID } from "node:crypto";
import { decodeTxReceipt, encodeTxProposal, signCoseSign1, uuidToBytes, verifyCoseSign1, type TxProposal } from "@tappay/shared";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../app.js";
import { config } from "../../../config.js";
import { serverPublicKeyBytes } from "../../../crypto/serverSigner.js";
import { db } from "../../../db/kysely.js";
import { createEnrolledDevice, type TestDevice } from "./testHelpers.js";

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

describe("/tx/submit (parked -- P2P proximity)", () => {
  const app = buildApp({ rateLimit: false, proximityRoutes: true });

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

  it("rejects a self-payment (sender and recipient resolve to the same account) with a typed 4xx, no journal write", async () => {
    const alice = await createEnrolledDevice(10_000n);
    const { base64, txUuid } = await buildSignedProposal(alice, alice, 1_000n);

    const response = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("SelfPayment");
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

  it("ADV-01b: a different signer reusing a settled tx_uuid is rejected, not resumed or handed the original receipt", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const { base64: aliceBase64, txUuid } = await buildSignedProposal(alice, bob, 1_000n);
    const original = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: aliceBase64 } });
    expect(original.statusCode).toBe(200);
    const originalReceipt = original.json().receipt as string;

    const [mallory, dave] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    // Mallory validly signs her OWN proposal (her own key, her own claimed
    // sender/recipient/amount) but reuses alice's already-settled tx_uuid.
    const { base64: malloryBase64 } = await buildSignedProposal(mallory, dave, 1_000n, { txUuid });

    const hijack = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: malloryBase64 } });

    expect(hijack.statusCode).toBe(409);
    expect(hijack.json().error).toBe("TxUuidConflict");
    expect(hijack.json().receipt).toBeUndefined();
    expect(JSON.stringify(hijack.json())).not.toContain(originalReceipt);

    const rows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(rows).toHaveLength(2); // still just alice/bob's original pair

    const daveBalance = await app.inject({ method: "GET", url: `/accounts/${dave.accountId}/balance` });
    expect(daveBalance.json().available_balance).toBe("0");
  });

  it("the receipt names the recipient device and echoes the receiver_nonce from the signed proposal", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const receiverNonce = uuidToBytes(randomUUID());
    const proposal: TxProposal = {
      tx_uuid: uuidToBytes(randomUUID()),
      sender_device_id: uuidToBytes(alice.deviceId),
      recipient_device_id: uuidToBytes(bob.deviceId),
      amount: 750n,
      currency: 'MAD',
      receiver_nonce: receiverNonce,
      ts: Date.now(),
    };
    const coseBytes = await signCoseSign1(encodeTxProposal(proposal), alice.signer);

    const response = await app.inject({
      method: 'POST',
      url: '/tx/submit',
      payload: { cose_sign1: Buffer.from(coseBytes).toString('base64') },
    });

    expect(response.statusCode).toBe(200);
    const verified = verifyCoseSign1(Buffer.from(response.json().receipt, 'base64'), serverPublicKeyBytes)!;
    const receipt = decodeTxReceipt(verified.payload);
    expect(Array.from(receipt.recipient_device_id)).toEqual(Array.from(uuidToBytes(bob.deviceId)));
    expect(Array.from(receipt.receiver_nonce)).toEqual(Array.from(receiverNonce));
  });

  it("rejects a non-positive amount with a typed 400, no journal write, before ever reaching the bank adapter", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const { base64, txUuid } = await buildSignedProposal(alice, bob, 0n);

    const response = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("InvalidAmount");
    const rows = await db.selectFrom("journal").selectAll().where("tx_uuid", "=", txUuid).execute();
    expect(rows).toHaveLength(0);
  });

  it("rejects an amount above the configured limit", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000_000_000n), createEnrolledDevice(0n)]);
    const { base64 } = await buildSignedProposal(alice, bob, config.maxTransferMinorUnits + 1n);

    const response = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("InvalidAmount");
  });

  it("rejects an unsupported currency", async () => {
    const [alice, bob] = await Promise.all([createEnrolledDevice(10_000n), createEnrolledDevice(0n)]);
    const { base64 } = await buildSignedProposal(alice, bob, 100n, { currency: "USD" });

    const response = await app.inject({ method: "POST", url: "/tx/submit", payload: { cose_sign1: base64 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("InvalidCurrency");
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
