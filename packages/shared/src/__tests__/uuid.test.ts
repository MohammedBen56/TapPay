import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytesToUuid, uuidToBytes } from "../uuid.js";

describe("uuid <-> bytes", () => {
  it("round-trips a random UUID", () => {
    const original = randomUUID();
    expect(bytesToUuid(uuidToBytes(original))).toBe(original);
  });

  it("round-trips the nil UUID (all-zero bytes)", () => {
    const nil = "00000000-0000-0000-0000-000000000000";
    expect(bytesToUuid(uuidToBytes(nil))).toBe(nil);
  });

  it("rejects a malformed UUID string", () => {
    expect(() => uuidToBytes("not-a-uuid")).toThrow();
  });

  it("rejects a byte array of the wrong length", () => {
    expect(() => bytesToUuid(new Uint8Array(15))).toThrow();
  });
});
