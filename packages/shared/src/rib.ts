/** Moroccan-shaped bank account identifiers for the v2 mock neobank
 * (docs/TapPay_v2_Technical_Design.md §4). A 24-digit RIB: 3-digit bank code
 * (999, deliberately unassigned so nothing resembles a real Moroccan bank),
 * 3-digit branch code, 16-digit account number, 2-digit check key. The check
 * key is IBAN mod-97-10 check-digit math (ISO 7064 MOD 97-10) applied to the
 * 22-digit body -- NOT the real, unpublished Bank Al-Maghrib RIB key
 * algorithm. The property this needs (typo detection before a network round
 * trip) is identical either way; see the design doc for why bit-exact
 * compatibility isn't a goal for a mock ledger.
 */

export const MOCK_BANK_CODE = "999";
const RIB_BODY_LENGTH = 22;

function mod97(numericString: string): bigint {
  return BigInt(numericString) % 97n;
}

/** ISO 7064 MOD 97-10 check-digit computation: append two placeholder zero
 * digits, take the remainder mod 97, subtract from 98. Shared by the RIB's
 * own check key and the derived IBAN's check digits below -- same algorithm,
 * different input string. */
function checkDigits(bodyForCheck: string): string {
  return (98n - mod97(bodyForCheck + "00")).toString().padStart(2, "0");
}

/** Builds a full 24-digit RIB from a branch + account number, computing the
 * check key -- the shape server/scripts/seed.ts (M1f) uses to provision demo
 * customers. */
export function buildRib(branch: string, accountNumber: string): string {
  if (!/^\d{3}$/.test(branch)) throw new Error(`branch must be exactly 3 digits: "${branch}"`);
  if (!/^\d{16}$/.test(accountNumber)) throw new Error(`accountNumber must be exactly 16 digits: "${accountNumber}"`);
  const body = MOCK_BANK_CODE + branch + accountNumber;
  return body + checkDigits(body);
}

/** True iff `rib` is 24 digits AND its check key matches the mod-97-10
 * computation over the first 22 -- catches transposed/mistyped digits before
 * any network round trip (the whole point of a self-checking identifier). */
export function isValidRib(rib: string): boolean {
  if (!/^\d{24}$/.test(rib)) return false;
  const body = rib.slice(0, RIB_BODY_LENGTH);
  const key = rib.slice(RIB_BODY_LENGTH);
  return checkDigits(body) === key;
}

/** Formats a 24-digit RIB into 4-digit groups for display, e.g.
 * "9997 8000 0000 0000 0621 033" -- purely cosmetic; the stored/wire form
 * stays the unspaced 24-digit string. Returns the input unchanged if it
 * isn't a plain digit string of the expected length. */
export function formatRib(rib: string): string {
  if (!/^\d{24}$/.test(rib)) return rib;
  return rib.match(/.{1,4}/g)!.join(" ");
}

/** Derives the MA IBAN for display -- never stored (see the design doc: the
 * RIB is the persisted identifier, the IBAN is computed on the fly). ISO
 * 13616: rearrange BBAN + country code + "00", convert letters to numbers
 * (ISO 7064 mapping, A=10..Z=35, so "MA" -> "22" "10"), take 98 - (mod 97),
 * pad to 2 digits, prepend as MAkk to the RIB. */
export function ribToIban(rib: string): string {
  if (!isValidRib(rib)) throw new Error(`cannot derive an IBAN from an invalid RIB: "${rib}"`);
  const rearranged = rib + "2210"; // BBAN + "MA" (as digits) + "00" (placeholder), "00" supplied by checkDigits()
  const check = checkDigits(rearranged);
  return `MA${check}${rib}`;
}
