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
