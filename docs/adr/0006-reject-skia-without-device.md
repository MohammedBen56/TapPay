# 0006 — Reject `react-native-skia` until there's a device to validate the 60fps condition

## Context

The original mobile design plan called for `@shopify/react-native-skia` for
exactly one deliberate use: an animated mesh sheen on the balance card, with
a named condition attached — "drop if it doesn't hold 60fps on the A51"
(the Galaxy A51 being the project's chosen performance floor, a mid-tier
2019 device, not the flagship S24 Ultra). Milestone 3 (mobile foundation)
was built in a session with no physical device attached to actually measure
frame rate.

## Decision

`@shopify/react-native-skia` was **not added** at all. The condition that
would justify adding it — real, measured 60fps on the A51 — cannot be
evaluated without a device, so rather than add the dependency and hope, the
balance-card sheen shipped as a static Reanimated-driven gradient glow
(`ScreenBackground.tsx`, later revised further under the Argent direction)
instead.

## Alternatives considered

- **Add Skia now, gate its use behind a runtime performance check.**
  Rejected: this ships an unvalidated dependency and a runtime branch for a
  condition nobody has actually measured yet — strictly worse than not
  shipping it, since it adds bundle size and a code path that might never be
  exercised correctly on first real use.
- **Skip the sheen effect entirely rather than approximate it.** Rejected:
  the design direction called for *some* ambient motion in that spot: a
  static Reanimated gradient is a reasonable placeholder that can be
  upgraded, not a design regression.

## Consequences

The Reanimated-only gradient is explicitly a placeholder, not a final
design decision — CLAUDE.md §4 records it as "a clean follow-up, not a
blocker." Any future PR that reaches for Skia should link back to this ADR
and state what device measurement justified it, rather than re-adding it on
the same speculative basis it was rejected on here.

## Revisit trigger

The first real device session that measures frame rate on the A51 under the
current animated-background implementation (Argent's four drifting blobs,
also currently unverified on the A51 — see the corresponding note in
CLAUDE.md §8). If that session shows real headroom, Skia becomes a
measured decision instead of a speculative one.
