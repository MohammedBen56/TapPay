# Security

TapPay is a mock neobank — see [CLAUDE.md §1](CLAUDE.md) for what that means
concretely (no real funds, ever, without a banking license). It carries a
real double-entry ledger and a real auth system, both adversarially tested,
and is treated with the same reporting discipline a production system would
be.

## Reporting a vulnerability

Open an issue, or contact the maintainer directly (see
`/.well-known/security.txt` for the current contact). Please include enough
detail to reproduce the finding — the affected route or flow, the request
shape, and what you expected versus what happened.

Do not open a public issue for a finding that would let an attacker exploit
it before a fix ships; use the direct contact instead.

## Scope

In scope: everything under `server/` and `mobile/` (both the live v2 routes
and the parked P2P surface — see [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
for why the parked path is treated as its own trust boundary), and
`packages/shared`.

Out of scope: the `telemetry/` harness (no production traffic, no user
data); denial-of-service findings against a single-instance local dev setup
(see the Ship List's Recommend/Decide buckets for the horizontal-scaling
and rate-limiting roadmap, which is where DoS resilience is actually being
addressed).

## What's already documented, on purpose

Known, deliberately deferred gaps are tracked in CLAUDE.md §11 (D1–D7) with
the reasoning for each — please check there before reporting one of those as
new. A threat model with named "accepted" rows lives at
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md), and real findings that were
already found and fixed are written up in
[`docs/incidents/`](docs/incidents/), each with the regression test that now
covers it.

## Response

There's no formal SLA at this project's current stage — see
`/.well-known/security.txt`'s `Expires:` field for how current this
statement is. A real response-time commitment is the natural next step once
this has actual users.
