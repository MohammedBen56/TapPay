# 0004 — `tx_uuid` is client-chosen and therefore not scoped to a caller

## Context

`tx_uuid` is the idempotency key for both the parked P2P COSE-signed path
and the live v2 `/transfers` route: resubmitting the same `tx_uuid` should
be a no-op that returns the existing settled result, so a client's network
retry can never double-spend. Because the client chooses the value, a naive
implementation that keys durable state on `tx_uuid` alone — without checking
who's presenting it and with what parameters — creates a settlement-slot
hijack: a second caller reusing an in-flight or settled `tx_uuid` with
different parameters gets resumed using *their* accounts/amount instead of
the original caller's. This was found via `/security-review`, not designed
in from the start — see `docs/incidents/0001-tx-uuid-settlement-hijack.md`.

## Decision

`tx_uuid` is explicitly documented as **not** scoped to a device, user, or
caller. `transfer()` checks that a resubmission is either byte-identical to
what created the row (for the COSE-signed path) or has the same
`account_id`/`counterparty_account_id`/`amount`/`currency` (for `/transfers`)
**before** branching on the reservation's state (COMMITTED/RELEASED/HELD) —
a different signer/caller reusing a `tx_uuid` with different parameters is
rejected outright with `tx_uuid_conflict`, never silently resumed using the
new caller's values.

## Alternatives considered

- **Scope `tx_uuid` to the authenticated caller (e.g. compose the idempotency
  key from `tx_uuid` + `account_id`).** Considered but rejected: this would
  make the vulnerability structurally impossible rather than requiring a
  runtime check, which sounds strictly better — but it silently breaks
  idempotent resubmission from a *different* legitimate context (e.g. a
  retry arriving with a slightly different, but still legitimate, request
  shape) and the parked COSE path's `tx_uuid` semantics predate the v2 auth
  model entirely. The runtime equality check achieves the same safety
  property without constraining the identifier's meaning across both paths.
- **Reject any resubmission outright, no idempotency.** Rejected: this
  reintroduces the double-spend-on-retry problem idempotency exists to
  solve in the first place.

## Consequences

Every future route that resolves durable state from a client-suppliable
identifier — a device ID, a nonce, a refresh token, a `tx_uuid` — needs the
same "check the caller before trusting the identifier" discipline. CLAUDE.md
§10 names this as a confirmed recurring pattern and mandates `/security-
review` on any route that keys durable state this way.

## Revisit trigger

If `tx_uuid` generation is ever moved server-side (removing client choice
entirely), this whole class of check becomes unnecessary — but that would
also break the offline-first assumption that lets a client generate an
idempotency key before it has network access to ask the server for one.
