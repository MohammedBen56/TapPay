import { describe, expect, it } from "vitest";
import { derToRaw, rawToDer } from "../ecdsaDer.js";

function hex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}

describe("ecdsaDer", () => {
  it("round-trips a signature where both r and s are the full 32 bytes, high bit unset", () => {
    const r = "1".repeat(63) + "2"; // 32 bytes, doesn't need a sign-guard byte
    const s = "3".repeat(63) + "4";
    const raw = hex(r + s);
    expect(derToRaw(rawToDer(raw))).toEqual(raw);
  });

  // The case that breaks naive converters #1: DER strips leading zero bytes from
  // r/s whenever the numeric value has them, so the DER INTEGER can be SHORTER
  // than 32 bytes -- the raw form must be left-padded back to 32, not
  // concatenated short.
  it("handles r/s shorter than 32 bytes (leading zero bytes stripped by DER)", () => {
    // 3 leading zero bytes, then a byte with the high bit UNSET (0x2b) so this
    // case is isolated from the sign-guard path tested separately below.
    const r = "00".repeat(3) + "2b" + "ab".repeat(28);
    const s = "00".repeat(20) + "01".repeat(12);
    const raw = hex(r + s);
    const der = rawToDer(raw);

    // Confirm the DER integer is genuinely shorter than 32 bytes (i.e. this test
    // actually exercises the padding path, not a no-op) and carries no sign-guard.
    expect(der[3]).toBe(29); // r's DER INTEGER length byte: 32 - 3 leading zeros
    expect(der[4]).toBe(0x2b); // no 0x00 guard prepended

    expect(derToRaw(der)).toEqual(raw);
  });

  // The case that breaks naive converters #2: when the high bit of r or s is set,
  // DER prepends a 0x00 sign-guard byte so the INTEGER isn't read as negative --
  // that byte must be stripped on the way back to raw, not left in (which would
  // make the raw value 33 bytes instead of 32).
  it("handles r/s with the high bit set (DER sign-guard 0x00 byte)", () => {
    const r = "ff".repeat(32); // high bit set for the entire value
    const s = "80" + "00".repeat(31); // high bit set, rest zero
    const raw = hex(r + s);
    const der = rawToDer(raw);

    expect(der[3]).toBe(33); // r's DER INTEGER is 33 bytes: 0x00 guard + 32 value bytes
    expect(der[4]).toBe(0x00); // the guard byte itself

    expect(derToRaw(der)).toEqual(raw);
  });

  it("handles both edge cases at once, in the same signature", () => {
    const r = "00".repeat(1) + "ff".repeat(31); // short AND high-bit-set after trim
    const s = "00".repeat(10) + "80" + "00".repeat(21); // short AND high-bit-set after trim
    const raw = hex(r + s);
    expect(derToRaw(rawToDer(raw))).toEqual(raw);
  });

  it("rejects a truncated DER signature rather than silently returning garbage", () => {
    const truncated = hex("3006020101020101").slice(0, 3);
    expect(() => derToRaw(truncated)).toThrow();
  });
});
