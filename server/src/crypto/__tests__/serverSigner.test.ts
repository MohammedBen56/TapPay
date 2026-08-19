import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeTxReceipt, verifyCoseSign1 } from "@tappay/shared";
import { describe, expect, it } from "vitest";
import { config } from "../../config.js";
import { compressedPublicKeyFromKeyObject } from "../ecPublicKey.js";
import { signServerReceipt } from "../serverSigner.js";

describe("signServerReceipt", () => {
  it("produces a COSE_Sign1 receipt that verifies against the server's own public key and carries the right facts", async () => {
    const privateKey = createPrivateKey(readFileSync(config.serverIdentityKeyPath));
    const publicKey = createPublicKey(privateKey);
    const compressedPublicKey = compressedPublicKeyFromKeyObject(publicKey);

    const txUuid = randomUUID();
    const amount = 12_345n;
    const currency = "MAD";
    const settledAt = new Date();
    const recipientDeviceId = crypto.getRandomValues(new Uint8Array(16));
    const receiverNonce = crypto.getRandomValues(new Uint8Array(16));

    const receiptBytes = await signServerReceipt({ txUuid, amount, currency, settledAt, recipientDeviceId, receiverNonce });

    const verified = verifyCoseSign1(receiptBytes, compressedPublicKey);
    expect(verified).not.toBeNull();

    const receipt = decodeTxReceipt(verified!.payload);
    expect(receipt.amount).toBe(amount);
    expect(receipt.currency).toBe(currency);
    expect(receipt.settled_at).toBe(settledAt.getTime());
    // cbor-x decodes byte strings as Node Buffer, not plain Uint8Array --
    // same content, different constructor, so toEqual needs both normalized.
    expect(Array.from(receipt.recipient_device_id)).toEqual(Array.from(recipientDeviceId));
    expect(Array.from(receipt.receiver_nonce)).toEqual(Array.from(receiverNonce));

    // Tamper detection: a wrong public key must not verify.
    const wrongKey = new Uint8Array(compressedPublicKey);
    wrongKey[5] ^= 0xff;
    expect(verifyCoseSign1(receiptBytes, wrongKey)).toBeNull();
  });
});
