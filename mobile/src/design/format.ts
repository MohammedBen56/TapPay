import { formatMinorUnits } from "@tappay/shared";

/** Renders a minor-units decimal string (as the API sends amounts, e.g.
 * "1250000") as a grouped major-unit display string ("12,500.00"). Grouping
 * is display-only, applied after formatMinorUnits' bigint-exact conversion
 * -- never derived by any float math (CLAUDE.md §5). */
export function formatMAD(minorUnitsString: string): string {
  const [whole, fraction] = formatMinorUnits(BigInt(minorUnitsString)).split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${fraction}`;
}

export function formatRibGrouped(rib: string): string {
  return rib.replace(/(.{4})/g, "$1 ").trim();
}

export function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Short form (day + month, no year/time) for tight list rows --
 * `formatDateTime`'s full year+time output is correct for a receipt/
 * detail screen but too long for a transaction-list row. Ship List v2
 * Wave 2 Phase 2: `TransactionRow.tsx` previously hand-rolled this exact
 * `toLocaleDateString` call inline instead of importing a shared
 * formatter -- factored out here rather than force-fitting the longer
 * `formatDateTime`, which would have regressed the row's readability. */
export function formatShortDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** Long form (full month name + year, no time) for formal documents --
 * the statement/proof-of-balance letter headers. A third distinct
 * hand-rolled `toLocaleDateString` call found during the same Wave 2
 * consolidation pass, factored out here too rather than left inline. */
export function formatLongDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}
