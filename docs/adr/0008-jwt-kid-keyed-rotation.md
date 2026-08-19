# 0008 — `kid`-keyed JWT signing keys, for near-free access-token rotation

## Context

`JWT_SECRET` had no rotation mechanism: a single string, registered as
`@fastify/jwt`'s `secret` directly. Rotating it meant either downtime (every
outstanding access token becomes invalid the instant the value changes) or
never rotating it at all. Because refresh tokens are already opaque,
server-side database rows rather than JWTs (ADR-0003), only the short-lived
access token (15 minutes by default) needs to survive a rotation window —
this ADR is about making that already-favorable situation actually usable.

## Decision

`config.ts`'s `jwtSigningKeys` is an ordered array of `{kid, secret}`: index
0 is always the current signing key (`JWT_SECRET` + `JWT_KID`, default
`"1"`); anything after it comes from `JWT_PREVIOUS_SECRETS`
(`kid:secret,kid:secret`), verify-only. `auth/plugin.ts` registers
`@fastify/jwt` with a `secret` resolver function instead of a plain string,
keyed by the token's own `kid` header — **which requires `decode: {
complete: true }` in the plugin registration**, because `@fastify/jwt`'s
default decode step returns only the payload, not the header, to a custom
secret resolver; this was found by direct reproduction (a debug build that
printed exactly what the resolver received), not assumed from documentation.
`routes/auth.ts`'s `signAccessToken` always signs with the current key and
tags the token with its `kid` explicitly.

**The rotation runbook this enables**: add a new key to `JWT_PREVIOUS_SECRETS`
*verify-only* → wait out the access-token TTL (15 min) so every token signed
under the old key has naturally expired → promote the new key to `JWT_SECRET`
+ bump `JWT_KID` → drop the old key from `JWT_PREVIOUS_SECRETS`. At no point
does an outstanding token stop verifying.

Verified end-to-end against a real running server, not just typechecked: a
token signed with `kid=1` under the original secret continued to verify
correctly after the server was restarted with a new `JWT_SECRET`/`kid=2` and
the old secret moved into `JWT_PREVIOUS_SECRETS`; a fresh login under the
rotated server signed a new `kid=2` token that also verified; a forged token
carrying an unrecognized `kid` was rejected.

## Alternatives considered

- **Asymmetric signing (RS256/ES256) with a JWKS endpoint.** Rejected: JWKS
  exists so a party other than the signer can verify tokens independently.
  Here the same process signs and verifies every token it issues, so an
  asymmetric keypair adds real complexity (key management, a public
  endpoint) to solve a problem — third-party verification — this system
  doesn't have. A `kid`-keyed symmetric secret set is the correct match for
  the actual shape of the problem.
- **No rotation mechanism; treat a leaked `JWT_SECRET` as a full outage
  event requiring every session to re-login.** Rejected as the status quo
  this ADR replaces — acceptable for a demo, not for a system claiming to
  be production-minded about its own secrets.

## Consequences

Every future call site that signs an access token must set `kid` explicitly
(there is currently exactly one: `signAccessToken`) — a token signed without
it falls back to the current key by construction (see `resolveSecret`'s doc
comment), which is safe but should be treated as a bug if it ever happens
outside that one call site, not relied upon.

## Revisit trigger

If a second process ever needs to verify tokens this server signs (a
different service, not just this server), migrate to asymmetric signing —
that's the point at which JWKS's actual value proposition (verification
without shared secret custody) starts to apply.
