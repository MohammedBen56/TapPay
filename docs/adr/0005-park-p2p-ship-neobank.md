# 0005 — Park the P2P proximity thesis; ship the neobank first

**Supersedes the original architecture (M0–M3): BLE GATT transport,
multi-sensor bump correlation, three online/offline settlement modes,
device attestation, COSE-signed peer proposals — all real, built, and
security-reviewed, none of it deleted.**

## Context

TapPay was originally built risk-first around a P2P proximity-payment
thesis: two phones bumped together, a fused multi-sensor signal binding the
tap to a BLE-transported signed transaction. M0 (the bump-correlation
telemetry harness) never met its own exit gate — no 200-bump varied-grip
session, no empirical `R_AB` distribution, no ratified threshold policy —
and the milestones built on top of it (M1's ledger and crypto, M2's offline
modes, M3's BLE transport) accumulated real engineering value without ever
producing a demonstrable end-to-end proximity payment a reviewer or user
could actually try. The last several sessions before this decision were
spent fighting BLE races, APK reinstall loops, and adb/firewall plumbing
rather than building product.

## Decision

Stop, invert the order. Ship a simple, complete, genuinely working mock
neobank first — login, balance, send, history, profile — with UI quality
that projects competence rather than "student project." Everything
proximity-related (BLE, bump/motion correlation, offline Mode B/C,
attestation, peer ECDH) becomes parked, in-repo, unrouted by default behind
`ENABLE_PROXIMITY_ROUTES` (server) and simply not imported from any live
screen (mobile) — not deleted, not rewritten, not degraded.

The server ledger, locking discipline, and adapter interface (`IBankAdapter`)
were kept as-is: a greenfield rebuild of an MVP neobank would arrive at the
same `journal` table, the same `lockAccountsInOrder` discipline, and the same
idempotent `tx_uuid` design (ADR-0002, ADR-0004) — re-deriving adversarially
tested code costs real time for zero benefit. The mobile UI layer was almost
entirely rebuilt, since nearly none of the P2P screens are relevant to a
login-balance-send-history-profile product — but the Expo project, gradle
config, dev-client build, and two-phone testing workflow survived, because
those cost real days to rediscover and are orthogonal to which product is
being built on top of them.

## Alternatives considered

- **Push through M0's exit gate first, then continue up the original
  milestone ladder.** Rejected: the gate is a data-collection problem (a
  dedicated ~200-bump capture session with both phones), not an engineering
  one, and blocking all further progress on it left months of ledger and
  crypto work with no product wrapped around it to show for it.
- **Delete the P2P work and start clean.** Rejected: the ledger and crypto
  layers are real, adversarially tested, and directly reusable — deleting
  code that already passed a security review to "simplify" the repo would
  have thrown away the hardest-won 55% of the server for no reason beyond
  tidiness.
- **Run both efforts in parallel.** Rejected as a false economy for a small
  team: context-switching between an unproven transport layer and a
  shippable product is how the original milestone ladder stalled in the
  first place.

## Consequences

Two live product surfaces now share one ledger and one `IBankAdapter`
implementation, verified by the same adversarial test suite (`ADV-01`
through `ADV-07` and the v2 route tests) — the parked suites run
automatically in CI via `buildApp({ proximityRoutes: true })` per test,
independent of the runtime flag, specifically so parking the code doesn't
let it silently bit-rot. CLAUDE.md §4 carries both milestone ladders (the
live v2 pivot and the original parked P2P work) side by side, with an
explicit rule for reviving parked work: flip the flag, wire a screen back
in, and update the STATUS lines in the same change — never silently
un-park something without recording it.

## Revisit trigger

M0's exit gate is unchanged and unmet: a dedicated ~200-bump varied-grip/
orientation telemetry session with both phones, now a scheduling question
rather than a hardware-availability one. If that session happens and
produces a ratified threshold policy, M3 (QR-triggered BLE transport,
already decoupled from M0's bump-correlation gate by its own earlier
decision to trigger on a QR scan rather than a bump) is the next milestone
to resume — not a restart of the whole ladder.
