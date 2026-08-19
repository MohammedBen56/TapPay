import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../../config.js";
import { consumeNonce, issueNonce, pendingNonceCount } from "../nonceStore.js";

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

  describe("TTL expiry and the reaper", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("consumeNonce rejects an expired nonce, not just a missing one", () => {
      const nonce = issueNonce();
      vi.advanceTimersByTime(config.enrollmentNonceTtlMs + 1);
      expect(consumeNonce(toBytes(nonce))).toBe(false);
    });

    it("an expired, never-consumed nonce is swept by the next issuance's reaper pass", () => {
      const before = pendingNonceCount();
      issueNonce(); // left to expire, never consumed
      expect(pendingNonceCount()).toBe(before + 1);

      vi.advanceTimersByTime(config.enrollmentNonceTtlMs + 1);
      expect(pendingNonceCount()).toBe(before + 1); // still present -- only reaped on the next issuance

      issueNonce(); // reapExpired() runs first, then this one is added
      expect(pendingNonceCount()).toBe(before + 1); // net unchanged: one reaped, one added
    });

    it("rejects issuance once the store hits its hard cap, even with nothing expired to reap", () => {
      const remaining = config.enrollmentNonceMaxPending - pendingNonceCount();
      for (let i = 0; i < remaining; i++) issueNonce();
      expect(pendingNonceCount()).toBe(config.enrollmentNonceMaxPending);
      expect(() => issueNonce()).toThrow(/too many pending/);
    });
  });
});
