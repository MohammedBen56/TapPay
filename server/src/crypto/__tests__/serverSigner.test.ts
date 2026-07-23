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

    const receiptBytes = await signServerReceipt({ txUuid, amount, currency, settledAt });

    const verified = verifyCoseSign1(receiptBytes, compressedPublicKey);
    expect(verified).not.toBeNull();

    const receipt = decodeTxReceipt(verified!.payload);
    expect(receipt.amount).toBe(amount);
    expect(receipt.currency).toBe(currency);
    expect(receipt.settled_at).toBe(settledAt.getTime());

    // Tamper detection: a wrong public key must not verify.
    const wrongKey = new Uint8Array(compressedPublicKey);
    wrongKey[5] ^= 0xff;
    expect(verifyCoseSign1(receiptBytes, wrongKey)).toBeNull();
  });
});
