# Incident postmortems

Blameless postmortems for real findings — bugs and vulnerabilities that were
found, root-caused, fixed, and (where applicable) converted into a
regression test so the same class of bug can't reappear unnoticed. These are
written after the fact from the actual fix commits and `/security-review`
history, not invented for this document.

The distinguishing question a postmortem answers isn't "what happened" —
it's "what changed permanently as a result." A finding without a named
regression test is a finding that could recur.

| Incident | Class |
|---|---|
| [0001](0001-tx-uuid-settlement-hijack.md) | `tx_uuid` settlement-slot hijack |
| [0002](0002-bearer-shaped-receipt.md) | Bearer-token-shaped `TxReceipt` |
| [0003](0003-unverified-email-enrollment.md) | Unverified email→device binding at enrollment |
| [0004](0004-nativewind-tailwind-v4-crash.md) | NativeWind/Tailwind v4 startup crash |

## The pattern across 0001–0003

All three security findings share one root cause: **a client-suppliable
identifier insufficiently bound to what it should be scoped to.** `tx_uuid`
(0001), a receipt with no recorded intended payee (0002), and an email
address with no ownership proof (0003) are the same shape of bug wearing
three different costumes. CLAUDE.md §10 now names this explicitly as a
confirmed recurring pattern and mandates `/security-review` on any new route
that keys durable state on a client-chosen identifier — the rule exists
because of these three, not as a generic best practice adopted in the
abstract.
