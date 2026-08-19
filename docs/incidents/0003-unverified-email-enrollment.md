# 0003 — Unverified email→device binding at enrollment

**Class:** client-suppliable identifier insufficiently bound to its scope
**Found via:** `/security-review`
**Status:** Closed by parking the vulnerable code — not fixed at the design level

## Impact

The parked P2P path's `/devices/enroll` route let a caller enroll a device
against an arbitrary email address (`email=victim@example.com`) with **zero
ownership proof** — no verification link, no confirmation code, nothing
establishing that the caller enrolling the device actually controls that
email. Anyone could bind a device identity to any email they chose to type.

## Timeline

Found during the same `/security-review` sweep as 0001 and 0002 — an audit
of every place the system accepts client-asserted identity without an
independent check.

## Root cause

The original P2P enrollment design assumed email as a lightweight,
low-stakes identifier for pairing devices to a person, without ever adding
the verification step (magic link, confirmation code, or equivalent) that
would make that assumption safe. It was never fixed at the design level —
the milestone moved on before this was addressed.

## Resolution — and why it's phrased as "closed by parking," not "fixed"

This is the one entry in the incident log that is **not** a genuine fix. The
vulnerable code (`server/src/parked/routes/devices.ts`'s `/devices/enroll`)
is parked behind `ENABLE_PROXIMITY_ROUTES` (default off, per ADR-0005) and
therefore unreachable in the live product — but the underlying design flaw
was never resolved. If proximity routes are ever flipped back on in a real
deployment without first addressing this, the gap is back, unchanged. This
distinction is deliberate and is called out explicitly in CLAUDE.md's D3 gap
entry, precisely so a future "we un-parked the P2P routes" change doesn't
mistake dormancy for remediation.

v2's actual account provisioning has no equivalent flow at all: accounts
only exist via `seed.ts`'s bank-provisioning script, a trusted, offline,
operator-run process by construction — so the live product was never
exposed to this class of bug in the first place, independent of the parked
code's status.

## Prevention

- `docs/THREAT_MODEL.md` (Phase 0) carries this as an explicit "accepted,
  gap remains" row rather than a "covered" one — the correct honest status.
- The rule for reviving parked work (CLAUDE.md §4) — flip the flag, wire a
  screen back in, update STATUS lines in the same change — should gain an
  explicit line item requiring this gap be addressed *before* `/devices/
  enroll` is un-parked into any environment with real users, not treated as
  optional cleanup.
