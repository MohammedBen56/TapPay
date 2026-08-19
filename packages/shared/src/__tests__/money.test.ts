import { describe, expect, it } from "vitest";
import { formatMinorUnits, parseMinorUnits } from "../money.js";

describe("formatMinorUnits", () => {
  it("renders whole and fractional centimes correctly", () => {
    expect(formatMinorUnits(12_345n)).toBe("123.45");
    expect(formatMinorUnits(100n)).toBe("1.00");
    expect(formatMinorUnits(5n)).toBe("0.05");
    expect(formatMinorUnits(0n)).toBe("0.00");
  });

  it("renders negative amounts with a leading '-', not a negative major part", () => {
    expect(formatMinorUnits(-12_345n)).toBe("-123.45");
    expect(formatMinorUnits(-5n)).toBe("-0.05");
  });

  it("handles amounts beyond safe-integer range without precision loss (the whole reason this is bigint)", () => {
    expect(formatMinorUnits(9_007_199_254_740_993_00n)).toBe("9007199254740993.00");
  });
});

describe("parseMinorUnits", () => {
  it("parses whole numbers, decimals, and leading-dot decimals", () => {
    expect(parseMinorUnits("123")).toBe(12_300n);
    expect(parseMinorUnits("123.45")).toBe(12_345n);
    expect(parseMinorUnits(".45")).toBe(45n);
    expect(parseMinorUnits("0.05")).toBe(5n);
  });

  it("pads a single fractional digit (e.g. '1.5' -> 1.50 MAD)", () => {
    expect(parseMinorUnits("1.5")).toBe(150n);
  });

  it("parses negative amounts", () => {
    expect(parseMinorUnits("-123.45")).toBe(-12_345n);
  });

  it("round-trips through formatMinorUnits", () => {
    for (const amount of [0n, 1n, 99n, 100n, 12_345n, -12_345n, 1_000_000_00n]) {
      expect(parseMinorUnits(formatMinorUnits(amount))).toBe(amount);
    }
  });

  it("rejects more than 2 fractional digits rather than silently truncating (CLAUDE.md §5: no float precision loss)", () => {
    expect(() => parseMinorUnits("123.456")).toThrow();
  });

  it("rejects empty input, bare signs, and non-numeric garbage", () => {
    expect(() => parseMinorUnits("")).toThrow();
    expect(() => parseMinorUnits("-")).toThrow();
    expect(() => parseMinorUnits(".")).toThrow();
    expect(() => parseMinorUnits("abc")).toThrow();
    expect(() => parseMinorUnits("12.3.4")).toThrow();
    expect(() => parseMinorUnits("1e5")).toThrow();
  });
});
