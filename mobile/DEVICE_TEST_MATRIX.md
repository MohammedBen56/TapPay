# Device test matrix

Real devices, real flows, dated, tied to a commit. **Findings — anything
that broke and got fixed — are recorded, not just passes**: a matrix with
zero failures reads as untested, not as flawless.

Devices: Galaxy S24 Ultra (`SM-S928B`) and Galaxy A51 (`SM-A515F`) — the
project's chosen performance floor (see ADR-0006).

## How to run this

Walk every flow in the table below on both devices after any change to
`mobile/`, and specifically after any change to a Ship List Phase 5 item
(crash reporting, screen-capture protection, the inactivity lock, cert
pinning) — those are exactly the additions least visible to `tsc --noEmit`
and most likely to only fail on real hardware. Add a dated row per run, not
per device — one row covers both columns for that pass.

## Core flows

| Date | Commit | Flow | S24 Ultra | A51 | Notes / findings |
|---|---|---|---|---|---|
| _(unfilled — Ship List Phase 6)_ | | Sign in (password) | | | |
| | | Enable biometric, kill app, re-enter via biometric | | | |
| | | Reveal/hide balance | | | |
| | | Send — saved contact | | | |
| | | Send — live QR scan | | | |
| | | Send — typed RIB + lookup | | | |
| | | Send — imported QR photo | | | |
| | | Send — NFC | | | |
| | | Settlement lands in both histories | | | |
| | | Postgres: journal pair sums to zero for the settled `tx_uuid` | | | |
| | | Receipt — share as image | | | |
| | | Receipt — share as PDF | | | |
| | | Sign out; confirm refresh token revoked server-side; confirm biometric re-entry is correctly refused | | | |

## Phase 5 additions (fill in once built)

| Date | Commit | Flow | S24 Ultra | A51 | Notes / findings |
|---|---|---|---|---|---|
| | | Deliberately thrown test crash (release build) — confirm symbolicated stack in Sentry | | | |
| | | Screen capture blocked on Home / Transaction Detail / Profile; recents-screen thumbnail blanked | | | |
| | | Inactivity lock triggers after the configured background threshold; biometric re-entry unlocks without a full sign-out | | | |
| | | Cert pinning: connection succeeds against the Caddy-fronted local endpoint; a deliberately wrong pin is rejected | | | |
| | | `BIOMETRIC_STRONG` vs `BIOMETRIC_WEAK` classification — confirm which class each device reports and that `requireAuthentication` behaves consistently on both | | | |

## Known hazards to check for specifically

- Reanimated 4 frame drops on the A51's 4GB RAM under the Argent animated
  background blobs (CLAUDE.md §8) — scroll Home's transaction list hard
  while the blobs animate.
- Camera QR-scan latency on the A51 vs. the S24 Ultra.
- `expo-doctor` / `expo install --check` passing does not substitute for
  this matrix — it catches dependency drift, not runtime behavior.
