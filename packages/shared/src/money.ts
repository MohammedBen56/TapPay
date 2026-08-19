/**
 * MAD, the only currency this project supports (CLAUDE.md §2/§11 -- multi-
 * currency is explicitly out of MVP scope), uses 2 minor-unit decimal places
 * (centimes), same as almost every real-world currency this format would
 * ever need to grow into. Not currency-parameterized on purpose: a real
 * multi-currency implementation needs a lookup table of decimal-place counts
 * per ISO 4217 code (JPY has 0, some have 3), which is out of scope until
 * multi-currency itself is (CLAUDE.md §11).
 */
const MINOR_UNITS_PER_MAJOR = 100n;
const DECIMAL_PLACES = 2;

/**
 * Renders a bigint minor-unit amount (centimes) as a "123.45" major-unit
 * display string -- NEVER via floating point (CLAUDE.md §5: money is bigint
 * minor units, no floats or decimals-as-float anywhere in the stack).
 * Negative amounts render with a leading '-' (e.g. a debit line item).
 */
export function formatMinorUnits(amount: bigint): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const major = abs / MINOR_UNITS_PER_MAJOR;
  const minor = abs % MINOR_UNITS_PER_MAJOR;
  const minorStr = minor.toString().padStart(DECIMAL_PLACES, "0");
  return `${negative ? "-" : ""}${major.toString()}.${minorStr}`;
}

/**
 * Parses a user-entered major-unit amount string ("123.45", "123", ".45")
 * into bigint minor units. Strict by design: rejects anything that isn't a
 * plain decimal number with at most 2 fractional digits -- more precision
 * than MAD's minor unit can represent must be a rejected input, never
 * silently truncated (CLAUDE.md §5), and non-numeric input must throw rather
 * than coerce to 0n or a NaN-shaped bigint (which doesn't exist -- BigInt()
 * itself throws on garbage, but only AFTER this function's own shape check
 * gives a clear, typed error instead of a raw parse exception).
 */
export function parseMinorUnits(input: string): bigint {
  const trimmed = input.trim();
  const match = /^(-?)(\d+)?(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match || (!match[2] && !match[3])) {
    throw new Error(`invalid amount: "${input}"`);
  }
  const [, sign, wholePart, fractionPart] = match;
  const whole = BigInt(wholePart ?? "0");
  const fraction = (fractionPart ?? "").padEnd(DECIMAL_PLACES, "0");
  const minor = whole * MINOR_UNITS_PER_MAJOR + BigInt(fraction);
  return sign === "-" ? -minor : minor;
}
