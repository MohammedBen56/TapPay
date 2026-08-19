# Threat model

STRIDE-lite, kept as one table rather than a long narrative, because the
table is the artifact a reviewer actually uses: threat → control → test →
status, including the honest rows. A row marked *Accepted* or *Closed by
parking* is not a gap in this document — it's the document doing its job.

## Assets

- Customer funds (the `journal`/`reservations`/`transfers` tables — the
  thing every other asset ultimately protects)
- Customer credentials (`customer_credentials.password_hash`) and refresh
  tokens (`auth_sessions.token_hash`)
- Customer PII (`accounts.display_name`, `rib`, `email`)
- The server's own signing key (`server/keys/server_identity.pem`, parked
  COSE path only)

## Trust boundaries

- Mobile device ↔ server, over the network (currently plaintext HTTP — see
  D1 below; TLS via a local Caddy reverse proxy is Ship List Phase 4)
- Server ↔ Postgres
- The `IBankAdapter` seam — where a real bank's core system would plug in;
  everything above this interface trusts everything below it to be correct,
  and nothing below it should ever need to trust anything above it
- The parked P2P proximity surface (`server/src/parked/`,
  `mobile/src/parked/`) — closed by default (`ENABLE_PROXIMITY_ROUTES`),
  treated as **its own trust boundary** even though it shares the same
  ledger, because its auth model (device attestation + COSE signing) is
  entirely different from v2's JWT/argon2id model and the two should never
  be assumed to inherit each other's guarantees

## Attacker capabilities in scope

- Network-adjacent (can observe/intercept traffic — relevant while D1 is
  open)
- Holds a stolen, unlocked device
- An authenticated, malicious customer (adversarial `/transfers` and
  `/beneficiaries` inputs)
- A malicious or compromised peer device, for the parked P2P path
  specifically (device attestation and COSE signing exist because of this
  capability)

## Explicitly out of scope

Nation-state adversaries; physical extraction from a hardware security
module; a malicious bank operator (once a real `IBankAdapter` implementation
exists); a compromised database superuser (see the role-separation note in
Ship List Phase 1 — it defends an application-layer bug or a compromised
app-role credential, not a superuser); iOS (out of scope per CLAUDE.md §2).

## Threats, controls, and status

| Threat (STRIDE) | Control | Test | Status |
|---|---|---|---|
| Tampering — transfer amount modified in flight (parked COSE path) | COSE_Sign1 signature over the payload including amount | Adversarial receipt-tamper cases, `server/src/parked/` | Covered |
| Repudiation / Replay — a settled transfer replayed | `tx_uuid` + receiver nonce + timestamp inside the signed payload, not alongside it | `ADV-01` | Covered |
| Elevation of privilege — hijacking another caller's `tx_uuid` settlement slot | Parameter-equality check before any state branch (ADR-0004) | `ADV-01b`, `transfers.test.ts` | Covered — [incident 0001](incidents/0001-tx-uuid-settlement-hijack.md) |
| Spoofing — a forged/replayed settlement receipt | Recipient device ID + nonce bound inside the signed payload | Parked-path receipt-forgery tests | Covered — [incident 0002](incidents/0002-bearer-shaped-receipt.md) |
| Spoofing — MITM during session key establishment (parked ECDH) | Ephemeral P-256 keys signed by the hardware identity key, transcript bound into HKDF `info` | `ADV-07` | Covered |
| Elevation of privilege — enrolling a device against an email you don't own | *(none — see status)* | *(none)* | **Accepted, closed by parking — [incident 0003](incidents/0003-unverified-email-enrollment.md).** Real gap if `ENABLE_PROXIMITY_ROUTES` is ever set in a real deployment. |
| Overdraft — two concurrent transfers both reading a stale balance | Ordered `SELECT ... FOR UPDATE` on `accounts` (ADR-0002) | `ADV-06`, the planned property-based concurrency suite (Ship List Phase 3) | Covered |
| Information disclosure — customer-ID enumeration via login | One generic 401 for every failure mode (unknown ID, bad password, locked) | `auth.test.ts` | Covered |
| Information disclosure — RIB enumeration via lookup | Tight per-route rate limit, identical 404 for unknown vs malformed | `transfers.test.ts`'s lookup cases | Covered |
| Information disclosure — password sent over the wire | *(none yet)* | *(none)* | **Accepted — D1.** Top-priority open item; Ship List Phase 4 (local Caddy TLS) is the first step toward closing it. |
| Denial of service / abuse — unauthenticated `/transfers` or `/beneficiaries*` abuse at scale | Global rate limit only; no per-route limit on `/transfers` | *(none)* | **Accepted — D7,** in progress: Ship List Phase 1 adds a Redis-backed per-route limit. |
| Repudiation — no server-side authorization for a large/unusual transfer beyond biometric login | *(none)* | *(none)* | **Accepted for MVP.** A Monzo-style Secret-QR or Revolut-style delayed-confirmation gate for high-value transfers is a Ship List *Recommend*-bucket item, not yet built. |
| Tampering — a compromised app credential mutating settled `journal` rows | *(none yet)* | *(planned)* | **In progress — Ship List Phase 1**, database role separation (`REVOKE UPDATE, DELETE, TRUNCATE` from the app role). |

## Notes on deliberate non-controls

- **Mode C's local SQLite persistence is unencrypted, on purpose.** The
  stored payload's security property is integrity (from the COSE signature),
  not confidentiality — encrypting it would add real complexity to defend a
  property the design never claimed. SQLCipher is a named future follow-up
  if that property ever needs to change, not an oversight today.
- **No hash-chaining of `journal` rows against a compromised database
  administrator.** Explicitly out of scope (see above) — and adding it would
  put a serialization point directly on the hottest write path, fighting the
  exact locking discipline ADR-0002 exists to protect, to defend against a
  threat actor this system doesn't consider in scope.
