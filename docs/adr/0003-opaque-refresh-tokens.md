# 0003 — Opaque rotating refresh tokens with whole-family revocation on reuse

## Context

Biometric re-entry needs the device to persist *something* long-lived, and
that thing must be both revocable by the server and never the password
itself. A pure-JWT approach (long-lived signed tokens, no server state)
can't be revoked before its own expiry — an engineer who ships "solid" auth
doesn't get to pretend JWTs are stateless the moment revocation matters.

## Decision

Access tokens are short-lived (15 min) stateless JWTs. Refresh tokens are
opaque 32 random bytes, stored server-side as a SHA-256 hash only (never the
raw token, `auth_sessions.token_hash`), and rotate on every use. Presenting
a token that has already been rotated (`replaced_by` set, not just
`revoked_at`) is treated as a theft signal: it revokes the **entire
`family_id` chain**, not just that one token — forcing a re-login where the
theft becomes visible to the legitimate holder, rather than silently
rejecting only the stolen token and leaving the attacker's session (or the
legitimate user's, whichever presents second) alive.

## Alternatives considered

- **Reject only the reused token, leave the rest of the family alone.**
  Rejected: this is the naturally "obvious" implementation and it's wrong —
  the whole point of family revocation is that a stolen-and-later-used token
  invalidates the legitimate holder's session too. A partial fix here
  reads as more polished (nobody gets logged out unnecessarily) but is
  actually a weaker security property.
- **Long-lived JWTs with no refresh rotation.** Rejected for the reason in
  Context — no revocation path before natural expiry.
- **Store the refresh token in plaintext, indexed for fast lookup.**
  Rejected: a hash-only store means a database read alone can never
  disclose a usable token, matching the treatment given to password hashes.

## Consequences

The refresh token, never the password, is what biometric re-entry unlocks
(`expo-secure-store` with `requireAuthentication: true`). Any future feature
proposing to cache the password itself on-device in any form is a
regression against this decision and should be stopped at review, not
merged and fixed later.

## Revisit trigger

If access-token TTL is ever lengthened significantly (e.g. to reduce refresh
traffic), the theft-detection window widens correspondingly and the
trade-off should be re-evaluated explicitly, not drifted into via an
unrelated performance change.
