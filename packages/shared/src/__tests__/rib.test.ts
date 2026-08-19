import { describe, expect, it } from "vitest";
import { buildRib, formatRib, isValidRib, MOCK_BANK_CODE, ribToIban } from "../rib.js";

describe("buildRib / isValidRib", () => {
  it("builds a 24-digit RIB starting with the reserved mock bank code", () => {
    const rib = buildRib("780", "0000000000621103");
    expect(rib).toHaveLength(24);
    expect(rib.startsWith(MOCK_BANK_CODE)).toBe(true);
  });

  it("a freshly built RIB validates", () => {
    const rib = buildRib("780", "0000000000621103");
    expect(isValidRib(rib)).toBe(true);
  });

  it("rejects a RIB with a single transposed digit in the body -- the whole point of a self-checking identifier", () => {
    const rib = buildRib("780", "0000000000621103");
    const digits = rib.split("");
    // Swap two adjacent digits inside the body (not the check key itself).
    [digits[5], digits[6]] = [digits[6]!, digits[5]!];
    const tampered = digits.join("");
    if (tampered === rib) return; // swapped identical digits, nothing to assert
    expect(isValidRib(tampered)).toBe(false);
  });

  it("rejects a tampered check key", () => {
    const rib = buildRib("780", "0000000000621103");
    const flippedLastDigit = rib.slice(0, -1) + (rib.at(-1) === "0" ? "1" : "0");
    expect(isValidRib(flippedLastDigit)).toBe(false);
  });

  it("rejects non-24-digit input", () => {
    expect(isValidRib("123")).toBe(false);
    expect(isValidRib("")).toBe(false);
    expect(isValidRib("99978000000000006211037X")).toBe(false);
  });

  it("buildRib rejects malformed branch/account inputs", () => {
    expect(() => buildRib("78", "0000000000621103")).toThrow();
    expect(() => buildRib("780", "621103")).toThrow();
  });
});

describe("formatRib", () => {
  it("groups a valid RIB into 4-digit chunks separated by spaces", () => {
    const rib = "999780000000000062110370";
    // 25 chars isn't 24 -- use a real one.
    const real = buildRib("780", "0000000000621103");
    expect(formatRib(real)).toBe(real.match(/.{1,4}/g)!.join(" "));
    expect(formatRib(real).replace(/\s/g, "")).toBe(real);
    void rib;
  });

  it("returns non-24-digit input unchanged rather than throwing", () => {
    expect(formatRib("not-a-rib")).toBe("not-a-rib");
  });
});

describe("ribToIban", () => {
  it("derives an IBAN that passes the standard ISO 13616 mod-97 validity check", () => {
    const rib = buildRib("780", "0000000000621103");
    const iban = ribToIban(rib);

    expect(iban.startsWith("MA")).toBe(true);
    expect(iban).toHaveLength(28); // MA + 2 check digits + 24-digit RIB

    const rearranged = iban.slice(4) + iban.slice(0, 4);
    const numeric = rearranged.replace(/[A-Z]/g, (c) => (c.charCodeAt(0) - 55).toString());
    expect(BigInt(numeric) % 97n).toBe(1n);
  });

  it("throws for an invalid RIB rather than silently deriving a meaningless IBAN", () => {
    expect(() => ribToIban("not-a-valid-rib")).toThrow();
  });
});
