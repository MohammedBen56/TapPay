# 0001 — `tx_uuid` settlement-slot hijack

**Class:** client-suppliable identifier insufficiently bound to its scope
**Found via:** `/security-review`
**Status:** Fixed, regression-tested

## Impact

`tx_uuid` is the idempotency key for both the parked P2P COSE-signed
transfer path and the live v2 `/transfers` route. Because the client
chooses the value and it was originally keyed only on the identifier
itself, a second caller could resubmit an **in-flight or already-settled**
`tx_uuid` belonging to a different sender, with different accounts and a
different amount, and have it resumed using the original reservation slot —
a real settlement-slot hijack, not a theoretical one. The affected code
path would honor the *new* caller's request against the *existing*
reservation row rather than rejecting the mismatch.

## Timeline

Found during a `/security-review` pass over the settlement path, prompted
by the project's standing rule to run that review on any route keying
durable state off a client-chosen identifier. Not found via a user report or
a production incident — this codebase has no production traffic — found by
deliberately adversarial review of exactly the code this postmortem is
about.

## Root cause

`transfer()` (and, separately, the parked `/tx/sync` route) checked whether
a reservation row already existed for a given `tx_uuid` and, if so, branched
on its state (`COMMITTED` / `RELEASED` / `HELD`) — but did **not** first
check that the existing row's `account_id`, `counterparty_account_id`,
`amount`, and `currency` matched what the *current* caller was presenting.
A `tx_uuid` collision (accidental or deliberate) between two different
transfer attempts fell straight into the state-branch logic using the
wrong party's parameters.

## Fix

The equality check now runs **before** any state branch: if an existing
reservation's parameters don't byte-match (COSE path) or field-match
(`/transfers` path) the current request, the call is rejected outright with
`tx_uuid_conflict` — never silently resumed. See ADR-0004 for the design
decision this fix produced (`tx_uuid` is explicitly documented as not scoped
to a caller, so every consumer must do this check itself) and
`MockBankAdapter.transfer()`'s inline comment, which carries this reasoning
at the exact line the check lives on.

## Prevention

- `ADV-01b` (`server/src/parked/routes/__tests__/sync.test.ts`) and the
  equivalent case in `server/src/routes/__tests__/transfers.test.ts` assert
  the reject-on-mismatch behavior directly, for both the parked and live
  paths.
- CLAUDE.md §5 and §10 name this finding explicitly as the origin of the
  "client-suppliable identifier" rule, so a future route implementer
  encounters the lesson before writing the same bug rather than after.
- A static Semgrep rule flagging any authed route reading an
  account/user-scoping identifier from the request body or params instead
  of `request.user.aid` is planned (Ship List, Phase 3) as a mechanical
  backstop against the broader pattern this incident is one instance of.
