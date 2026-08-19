import { describe, expect, it } from "vitest";
import { consumeNonce, issueNonce } from "../nonceStore.js";

function toBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

describe("nonceStore", () => {
  it("consumes a freshly issued nonce exactly once", () => {
    const nonce = issueNonce();
    expect(consumeNonce(toBytes(nonce))).toBe(true);
    expect(consumeNonce(toBytes(nonce))).toBe(false); // replay rejected
  });

  it("rejects a nonce that was never issued", () => {
    expect(consumeNonce(new Uint8Array(16))).toBe(false);
  });
});
