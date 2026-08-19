# TapPay v2 — Technical Design: Mock Neobank MVP

Status: approved plan, implementation starting. Companion to
`/home/mohab/.claude/plans/elegant-hopping-lark.md` (the working plan file) and
supersedes this doc's own prior placeholder. Visual direction reference:
`tappay-v2-mockup.html` (Artifact, "Obsidian & Metal," revision 2).

## 1. Product scope

A fully working, single-shot mock neobank on Android: sign in with a
bank-issued customer ID + password, see a balance (hidden by default), send
money to a saved contact / scanned QR / manually-typed account number with a
required reference string, view transaction history, and view/share your own
bank details. Sign out and back in. English only. Three-tab navigation:
Home / Send / Profile.

Explicitly **out of scope for this MVP** (parked, not deleted — see §7): BLE
GATT transport, bump/motion sensor correlation, online/offline settlement
modes, device attestation, COSE-signed peer-to-peer proposals, offline IOUs.

## 2. Why this exists (context)

TapPay M0–M3 delivered real, security-reviewed proximity-payment
infrastructure, but the product built on top of it was a transport-layer demo,
not something a user could actually use — M0's bump-correlation exit gate is
still unmet, M3 is device-unverified, and recent sessions were spent on BLE
race conditions and adb/firewall plumbing rather than product. Owner decision:
invert the build order — ship the simple, complete thing first, sensor/radio
work returns as v2.

## 3. Threat model (new — nothing like this existed before)

The pre-v2 system had no user-facing auth at all; identity was "possession of
an enrolled hardware key." v2 introduces a real credential a human types, so a
real threat model is needed:

- **Credential stuffing / brute force** — mitigated by argon2id hashing,
  per-account lockout (5 failures → 15 min), and a tight per-route rate limit
  on `/auth/login`. Login returns one generic 401 for unknown-customer,
  bad-password, and locked-account cases — no username enumeration.
- **Stolen access token** — 15-minute JWT lifetime bounds the exposure window;
  the token carries no secret beyond identity claims.
- **Stolen refresh token** — the highest-value target, since it's what sits in
  the phone's secure storage. Mitigated by: opaque (not a parseable JWT),
  stored server-side as a SHA-256 hash only (a DB leak doesn't yield usable
  tokens), rotated on every use, and reuse of an already-rotated token
  revokes the entire session family (classic refresh-token-theft detection).
- **IDOR on account/transaction data** — every data route is scoped to `me`
  (`/accounts/me/balance`, `/accounts/me/transactions`) or ownership-checked
  server-side (`/transfers/:txUuid`, `/beneficiaries/:id`); nothing is looked
  up by a client-supplied account ID.
  the way `/accounts/:accountId/balance` was previously.
- **RIB/enumeration probing** — `/lookup/rib/:rib` is a real information
  disclosure surface by design (you must be able to look up a name before
  sending to a typed RIB), rate-limited tightly and gated on syntactic
  check-key validity before touching the DB.
- **Biometric bypass** — biometric auth on-device gates *local access to a
  stored refresh token*, not a server-side check. This is standard mobile
  practice (the OS is the trust boundary for "is this the enrolled user's
  finger/face"), but it means device compromise while unlocked bypasses it —
  no different from any banking app's biometric unlock.
- **Carried forward from CLAUDE.md §11**, unaffected by this pivot: D1 (no
  TLS — still open, still the top item before any real deployment), D2
  (unauthenticated balance/receipt reads — **now closed** for the new routes,
  since everything is Bearer-scoped; the parked proximity routes' D2 exposure
  is moot while unrouted), D3 (unverified email at enrollment — **closed**:
  v2 has no self-service enrollment at all, credentials are bank-provisioned).

## 4. Data model

Additive migrations `012`–`016` on top of the existing schema (`accounts`,
`devices`, `journal`, `reservations`, `offline_intents` — all untouched).

```
accounts (existing, extended)
  + display_name TEXT
  + rib CHAR(24) UNIQUE CHECK (rib ~ '^[0-9]{24}$')      -- 012
    (both nullable: the seeded nil-UUID mint row keeps no RIB/display_name)

customer_credentials                                       -- 013
  customer_id      TEXT PRIMARY KEY
  user_id          UUID UNIQUE REFERENCES accounts(user_id)
  password_hash    TEXT NOT NULL
  failed_attempts  INT NOT NULL DEFAULT 0
  locked_until     TIMESTAMPTZ
  created_at       TIMESTAMPTZ

auth_sessions                                               -- 014
  id            UUID PRIMARY KEY
  user_id       UUID REFERENCES accounts(user_id)
  token_hash    BYTEA UNIQUE          -- sha256(refresh token), never the raw token
  family_id     UUID                  -- ties a rotation chain together
  issued_at     TIMESTAMPTZ
  expires_at    TIMESTAMPTZ
  revoked_at    TIMESTAMPTZ
  replaced_by   UUID

beneficiaries                                                -- 015
  id              UUID PRIMARY KEY
  owner_user_id   UUID REFERENCES accounts(user_id)
  display_name    TEXT NOT NULL
  rib             CHAR(24) NOT NULL
  created_at      TIMESTAMPTZ
  UNIQUE (owner_user_id, rib)

transfers                                                     -- 016
  tx_uuid           UUID PRIMARY KEY
  from_account_id   UUID
  to_account_id     UUID
  amount            BIGINT
  currency          CHAR(3)
  reference         TEXT NOT NULL
  created_at        TIMESTAMPTZ
```

**Why `customer_credentials` is a separate table, not columns on `accounts`:**
the mint account (`is_mint = true`) has no customer and should never need a
fake password hash to satisfy a `NOT NULL`.

**Why `transfers` is a separate table, not a `reference` column on
`journal`:** a transfer's metadata lives once, keyed by `tx_uuid`, instead of
duplicated on both journal rows where it could silently diverge. `journal` —
this codebase's most adversarially-tested surface (sum-to-zero pairs,
`UNIQUE(tx_uuid, account_id)`, the 100-concurrent-transfer deadlock stress
test) — stays structurally untouched. History reads pay one extra join against
an existing index; negligible.

**Account identifier — a 24-digit Moroccan RIB**, not a UUID or email, because
it must be *typeable* (manual entry is a named requirement) and
*self-checking* (catch a typo before a network round trip). Layout: `999`
(bank code, deliberately unassigned — this must never resemble a real
Moroccan bank identifier) + 3-digit branch + 16-digit account body + 2-digit
check key computed as IBAN mod-97-10 over the 22-digit body. This is
documented plainly as IBAN check-digit math, not bit-exact Bank Al-Maghrib RIB
algorithm — the property we need (typo detection) is the same either way. The
MA IBAN (`MA` + 2-digit IBAN check + the 24-digit RIB) is derived for display,
never stored.

## 5. API contract

Public: `GET /health`, `POST /auth/login`, `POST /auth/refresh`.

Authenticated (Bearer JWT; money as minor-unit decimal strings, matching the
existing balance-route convention):

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/logout` | Revoke the presented refresh token → 204 |
| GET | `/me` | `{customer_id, display_name, account_id, rib, iban, currency}` |
| GET | `/accounts/me/balance` | `{account_id, currency, available_balance}` |
| GET | `/accounts/me/transactions` | Keyset-paginated (`?limit&before`) history with counterparty + reference |
| POST | `/transfers` | `{tx_uuid, to_rib \| to_beneficiary_id, amount, currency, reference}` — client-generated `tx_uuid` is the idempotency key |
| GET | `/transfers/:txUuid` | Detail view, ownership-checked |
| GET | `/lookup/rib/:rib` | Pre-send validation → `{rib, display_name}` or 404 |
| GET/POST/PATCH/DELETE | `/beneficiaries[/:id]` | Always scoped by the token's `owner_user_id`, never the request body |

`reference`: required, trimmed, 1–140 chars, C0 control characters rejected,
NFC-normalized. `/transfers` reuses `routes/tx.ts`'s existing self-payment /
amount / currency guards verbatim — they already encode CLAUDE.md §5.

Full request/response DTOs live in `packages/shared/src/api.ts`, imported by
both server and mobile so the contract is typed end to end, not
independently hand-maintained on each side.

## 6. Auth token lifecycle

```
login (customer_id, password)
  → argon2id verify against customer_credentials.password_hash
  → 401 (generic) on any failure; failed_attempts++; lock at 5
  → on success: issue access JWT (15 min) + refresh token (60 days, opaque,
    stored as sha256 hash in auth_sessions, family_id = new UUID)

refresh (refresh_token)
  → hash, look up in auth_sessions
  → not found / expired / revoked → 401
  → already-rotated (replaced_by set) → REVOKE THE WHOLE FAMILY, 401
    (this is the theft-detection signal: a legitimate client never presents
    an already-superseded token)
  → else: issue new access + refresh pair, mark old row revoked_at +
    replaced_by = new row's id, same family_id carried forward

logout (refresh_token)
  → hash, mark that row revoked_at = now(); 204 regardless of prior state
```

Mobile side: first login posts credentials directly. On success, offer
"Enable biometric sign-in?" — accepting stores the **refresh token** (never
the password) in `expo-secure-store` with `requireAuthentication: true`, and
the customer ID in plain prefs for prefill. Every subsequent launch: customer
ID prefilled, one biometric prompt unlocks the stored refresh token, which is
immediately exchanged via `/auth/refresh`. A single `apiClient` module owns
attaching the access token, catching 401s, refreshing once
(single-flight — concurrent requests must not each trigger their own
refresh), and retrying. Sign-out calls `/auth/logout` then wipes secure
storage unconditionally, even if the network call fails.

## 7. What happens to the parked code

Moved to `server/src/parked/` (structure preserved: `parked/attestation/*`,
`parked/routes/{devices,sync,deviceLookup}.ts`, `parked/routes/tx-cose.ts` split
out of today's `tx.ts`), each with its `__tests__` directory moving alongside
so the suites keep running. Registered only when
`config.enableProximityRoutes` (env `ENABLE_PROXIMITY_ROUTES`, default
**false**); `BuildAppOptions.proximityRoutes?: boolean` lets the moved tests
opt back in. This is a real security fix, not housekeeping: `POST /tx/submit`
is unauthenticated today, which is untenable once the product has real
customer accounts sharing the same server.

Migrations `005`/`009`/`011` and the `offline_intents` table stay applied —
never rewrite an applied migration, and the idle table costs nothing.

Mobile's BLE/telemetry/session-demo screens move to `mobile/src/parked/`
alongside the new `mobile/app/` tree; nothing there is deleted.

## 8. Mobile architecture

Expo + React Native, Android-only, `expo-router` for real native-stack
navigation (replacing today's hand-rolled `useState<Screen>` in `App.tsx`).
NativeWind v4 + react-native-reusables for UI primitives with design tokens
as the single source of truth (`mobile/src/design/tokens.ts`, mirrored into
`tailwind.config.js`). Reanimated + Moti for motion, `expo-haptics` tied to
semantic events, `@gorhom/bottom-sheet` for the send flow, FlashList for
transaction history. `@shopify/react-native-skia` is scoped to exactly one
use (the balance card's animated sheen) behind a performance-tier gate, with
a static-gradient fallback, and is dropped entirely if it doesn't hold 60fps
on the Galaxy A51 (Exynos 9611) — the perf floor, not the S24 Ultra.

See the plan file's Milestone 3 section for the design-system notes carried
forward from the mockup review round (type-scale consistency across every
screen, not just hero elements; a glass/translucent button treatment instead
of a flat gradient fill; continued background-motion iteration once it's real
on-device Reanimated rather than a CSS approximation).

## 9. Greenfield vs. adapt — recorded decision

Full analysis lives in the plan file. Summary: **server is adapted (~55%
survives — the ledger core, lock ordering, idempotency, bigint discipline —
and it's the hard, adversarially-tested 55%); mobile's UI layer is rebuilt in
place** (almost none of the 4,245 existing lines survive contact with the new
product, but the Expo project, gradle config, dev-client build, and the
hard-won WSL2/adb workflow are kept because rebuilding *that* costs days).
Repo is kept, not restarted.

## 10. Deferred / accepted gaps register (carries forward CLAUDE.md §11)

| ID | Gap | v2 status |
|---|---|---|
| D1 | No TLS | Still open — top item before any real deployment |
| D2 | Unauthenticated balance/receipt reads | Closed for new routes (Bearer-scoped); moot for parked routes while unrouted |
| D3 | Unverified email at enrollment | Closed — no self-service enrollment; credentials are bank-provisioned |
| D4 | Mode C `OfflineIou` has no receiver nonce | N/A while Mode C is parked |
| D5 | Attestation revocation, SQLCipher, iOS, real bank adapter, KYC/AML | Unchanged, still deferred |

New gaps opened by v2, to track the same way:

| ID | Gap | Reason deferred |
|---|---|---|
| D6 | RIB uses IBAN mod-97 check math, not the real Bank Al-Maghrib RIB key algorithm | Typo-detection property is what's needed for a mock ledger; bit-exact algorithm isn't published/needed for a non-real bank |
| D7 | No email/SMS verification loop for credential delivery ("the bank provides it IRL") | Seed script prints credentials directly for demo purposes; a real provisioning flow is out of MVP scope |
| D8 | Refresh-token family revocation is the only theft signal — no device fingerprinting / anomaly detection | Standard mobile-app posture; anomaly detection is a mature-product feature, not an MVP one |
