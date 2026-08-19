# 0001 — Money is bigint minor units, never float, stack-wide

## Context

Every monetary value in a banking system is eventually compared, summed, and
persisted. Floating-point arithmetic is not exact for base-10 fractional
values (0.1 + 0.2 !== 0.3 in IEEE 754), so any float in the money path is a
latent rounding-error bug — worse in a ledger, where correctness is defined
as an exact sum, not an approximately-correct one.

## Decision

Currency is MAD. All monetary values are integer minor units (centimes) as
`bigint`, from the Postgres column type (`journal.amount`, `reservations.amount`,
`transfers.amount` are all `bigint`) through the API wire format (minor-units
strings, never JSON numbers — see `packages/shared/src/api.ts`) to the mobile
display layer. `pg.types.setTypeParser(20, BigInt)` and the matching `NUMERIC`
(oid 1700) parser in `server/src/db/kysely.ts` make this true at the database
boundary, not just by convention in application code. `formatMAD`
(`mobile/src/design/format.ts`) formats `formatMinorUnits`'s bigint-exact
string output directly; it never re-parses through a float for
thousands-grouping.

## Alternatives considered

- **Decimal/numeric library types (e.g. `decimal.js`) throughout.** Rejected:
  adds a dependency and a serialization boundary everywhere money crosses a
  function signature, for no correctness benefit bigint doesn't already give
  at zero cost, since currency has a fixed number of decimal places (MAD's
  centime) and never needs arbitrary-precision fractional math.
- **Floats with a rounding policy.** Rejected outright — a "rounding policy"
  is a euphemism for "we've decided which transactions are allowed to be
  wrong by a centime."

## Consequences

Every new table, DTO, and UI string touching money must be reviewed for
float leakage — this is the exact class of bug `/security-review` exists to
catch, and a static rule flagging `parseFloat`/`Number()`/`.toFixed()` on any
money-shaped identifier is planned (Ship List, Phase 3) so it's caught
mechanically rather than relying on every future contributor remembering it
by convention.

## Revisit trigger

Never, for this application's scope. If TapPay ever needs a currency with a
non-fixed or unusually large number of decimal places (some cryptocurrencies
go to 18), that would need its own ADR, not a change to this one.
