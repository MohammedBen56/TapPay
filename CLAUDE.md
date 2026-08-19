# TapPay — Project Context (CLAUDE.md)

## 1. What this is
TapPay is a mock neobank app: bank-issued customer ID + password sign-in,
biometric re-entry, a balance you can hide/reveal, sending money to a saved
contact / scanned QR / typed RIB / imported QR photo with a required
reference, transaction history, and a shareable profile QR. Backend is a MOCK
neobank (double-entry ledger). It moves no real money. Never connect this to
real funds without a banking license (Bank Al-Maghrib). Currency is MAD. All
monetary values are integer minor units (centimes) as bigint. Floating point
for money is forbidden anywhere in the stack.

**This is a pivot, not the original plan.** TapPay was originally built
risk-first around a P2P proximity-payment thesis: two phones bumped together,
a fused multi-sensor signal binding the tap to a BLE-transported signed
transaction. That work (M0–M3 below) is real, security-reviewed, and
**parked, not deleted** — a deliberate owner decision (see §4) to ship a
complete, usable app first and treat proximity payments as a v2 upgrade. If
you're looking for BLE/bump/attestation/offline-mode code, it's under
`server/src/parked/` and `mobile/src/parked/`, unrouted by default.

## 2. Scope
- MVP target platform: Android only. iOS is out of scope (see §12).
- No BLE, no bump/motion sensing, no online/offline settlement modes, no
  device attestation in the live app. All of that is parked (§4's M0–M3,
  still real and intact, just not wired into the shipping product).
- Do not build any real payment-rail integration. The `IBankAdapter` seam is
  the only place a real bank would ever plug in.
- No self-service signup. A customer's `customer_id` + password are
  provisioned by `server/scripts/seed.ts` (the bank's provisioning system),
  exactly as a real bank would issue them out-of-band. There is no
  "create account" flow anywhere in the app.

## 3. Repository layout (monorepo)
```
tappay/
├── docker-compose.yml         # postgres 16 (host :5433), pgadmin, telemetry
├── pnpm-workspace.yaml        # members: server, mobile, packages/shared
├── docs/                      # TapPay_Technical_Spec_v2.1.md (original P2P spec),
│                              #   Build_Guide, M0_correlation_results.md,
│                              #   TapPay_v2_Technical_Design.md (the neobank
│                              #   pivot's design doc -- product scope, threat
│                              #   model, data model, API contract, auth
│                              #   lifecycle; read this alongside this file)
├── packages/shared/           # @tappay/shared -- crypto + wire-format + v2 API package
│   └── src/                   #   api.ts (typed request/response DTOs for every
│                              #   v2 route, hand-kept in sync with the server
│                              #   handlers -- not generated), rib.ts (Moroccan
│                              #   RIB build/validate/format + IBAN derivation,
│                              #   ISO 7064 mod-97-10), money.ts
│                              #   (formatMinorUnits/parseMinorUnits), plus the
│                              #   original COSE_Sign1/CBOR/P-256/ECDH crypto
│                              #   layer (still real, still tested, now
│                              #   dormant until the parked P2P code resumes).
│                              #   ~90% of the repo's tests live here.
├── server/                    # @tappay/server -- Node.js/Fastify mock neobank + ledger
│   ├── migrations/*.cjs       # node-pg-migrate, applied in numeric order.
│   │                           #   001-011: original ledger/devices/journal/
│   │                           #   reservations/offline_intents schema (still
│   │                           #   live -- the ledger didn't change). 012-016:
│   │                           #   the v2 pivot's schema (§4's M1b).
│   ├── scripts/               # seed.ts (the bank's customer provisioning --
│   │                           #   see §9), generate-server-key.ts (§9 bootstrap)
│   ├── keys/                  # server_identity.pem -- GITIGNORED, generate locally
│   ├── src/auth/               # v2: passwords.ts (argon2id), refreshTokens.ts
│   │                           #   (rotating opaque tokens + theft-detection),
│   │                           #   plugin.ts (@fastify/jwt registration + the
│   │                           #   app.authenticate preHandler)
│   ├── src/routes/             # v2 live routes: auth.ts, me.ts, transfers.ts,
│   │                           #   lookup.ts, beneficiaries.ts. tx.ts is
│   │                           #   trimmed to two unauthenticated GET routes
│   │                           #   (superseded by /accounts/me/*, kept live
│   │                           #   only until nothing references them).
│   └── src/parked/             # the entire original P2P proximity surface --
│                               #   attestation/, routes/{devices,sync,
│                               #   deviceLookup,tx-cose}.ts + their
│                               #   __tests__. Unregistered unless
│                               #   config.enableProximityRoutes is true. See
│                               #   server/src/parked/README.md.
├── mobile/                    # @tappay/mobile -- React Native (Expo) app
│   ├── app/                    # expo-router file-based routes (the live app):
│   │                           #   _layout.tsx (fonts, providers, the
│   │                           #   Stack.Protected auth gate), sign-in.tsx,
│   │                           #   (tabs)/{_layout,index,send,profile}.tsx
│   │                           #   (Home/Send/Profile, the only 3 tabs),
│   │                           #   transfer/[txUuid].tsx (receipt/detail)
│   ├── src/design/             # tokens.ts + palette.js (the single color/type
│   │                           #   source, mirrored into tailwind.config.js --
│   │                           #   see §8), format.ts (money/RIB/date display)
│   ├── src/api/                # client.ts (fetch wrapper: bearer attach,
│   │                           #   single-flight 401 refresh-and-retry),
│   │                           #   endpoints.ts (typed wrappers over
│   │                           #   packages/shared's api.ts DTOs)
│   ├── src/auth/               # AuthContext.tsx (the state machine: loading /
│   │                           #   signedOut / awaitingBiometricPrompt /
│   │                           #   signedIn), secureStore.ts (customer-id +
│   │                           #   biometric-gated refresh token, expo-secure-
│   │                           #   store), tokenStore.ts (module-level token
│   │                           #   holder the API client reads directly),
│   │                           #   balanceVisibility.ts (persisted eye-toggle)
│   ├── src/components/         # GlassButton.tsx (the platinum-fill primary /
│   │                           #   glass secondary button treatment -- see
│   │                           #   §8's design notes), ScreenBackground.tsx,
│   │                           #   Card.tsx, TextField.tsx, SegmentedControl.tsx,
│   │                           #   TransactionRow.tsx, ConfirmDialog.tsx
│   ├── src/qr/                 # profileQr.ts -- the mobile-only {rib,
│   │                           #   display_name} QR payload convention shared
│   │                           #   between Profile (encode) and Send's
│   │                           #   scan/import (decode). Never crosses the
│   │                           #   wire as a typed shape -- doesn't belong in
│   │                           #   packages/shared.
│   ├── src/config/serverUrl.ts # still live -- SERVER_BASE_URL
│   ├── src/util/               # base64.ts, uuid.ts -- still live, generic
│   ├── src/parked/             # the entire original P2P mobile surface --
│   │                           #   crypto/identity.ts, db/offlineIntents.ts,
│   │                           #   native/TapPayNative.ts, net/connectivity.ts,
│   │                           #   payments/{bleTransport,paymentFlow}.ts,
│   │                           #   screens/{PayScreen,SessionDemoScreen,
│   │                           #   BleDemoScreen,TelemetryScreen}.tsx,
│   │                           #   telemetry/, transport/qr.ts (COSE QR),
│   │                           #   components/{qrFlow,IdentityHeader}.tsx,
│   │                           #   config/{sensorThresholds,serverPublicKey}.ts.
│   │                           #   Nothing in app/ imports any of this.
│   ├── modules/tappay-native/  # Expo Modules API native code (Kotlin) --
│   │                           #   KeyStoreManager, SensorStreamer,
│   │                           #   BleGattTransport/BleTransportService. Still
│   │                           #   present, still compiles, called by nothing
│   │                           #   in the live JS bundle (only by parked/).
│   ├── babel.config.js         # babel-preset-expo (jsxImportSource: nativewind)
│   │                           #   + nativewind/babel + react-native-worklets/plugin
│   ├── metro.config.js         # workspace symlink shim (unchanged, see §8) +
│   │                           #   withNativeWind(config, {input: './global.css'})
│   ├── tailwind.config.js      # requires src/design/palette.js -- see §8
│   └── global.css              # `@tailwind base/components/utilities;` --
│                               #   Tailwind v3 directives (NOT v4 -- see §8)
├── telemetry/                  # Python FastAPI + Chart.js harness (Docker only).
│                               #   Unaffected by the v2 pivot -- still exists
│                               #   for whenever M0's bump-correlation work
│                               #   resumes. Not used by the live app.
├── ops/                        # Ship List Phase 2+ (production-readiness pass,
│                               #   docs/adr/, docs/incidents/, docs/THREAT_MODEL.md
│                               #   are this same pass's Phase 0). prometheus/
│                               #   {prometheus.yml,alerts.yml} -- scrapes the
│                               #   host-run server's GET /metrics
│                               #   (server/src/metrics.ts), alert rules keyed
│                               #   entirely off checkLedgerInvariants()
│                               #   (server/src/ledger/invariants.ts) via the
│                               #   tripwire job (server/src/tripwire.ts).
│                               #   grafana/{provisioning,dashboards} -- the
│                               #   committed "TapPay Ledger" dashboard,
│                               #   auto-provisioned, not clicked together by
│                               #   hand. See §9 for how to run this stack.
├── semgrep/                    # Ship List Phase 3 (adversarial proof). 5 custom
│                               #   rules (rules/*.yml), each citing the invariant
│                               #   or real incident it encodes, each with a
│                               #   same-directory fixture pair (rules/<id>.ts,
│                               #   `// ruleid:`/`// ok:` annotated) --
│                               #   semgrep/README.md has the full table and the
│                               #   fixture/nosemgrep placement rules (verified by
│                               #   direct reproduction, not assumed from docs).
├── Caddyfile                   # Ship List Phase 4 (ADR-0009). TLS termination in
│                               #   front of the host-run server -- Mozilla
│                               #   "Intermediate" profile, a single SNI-agnostic
│                               #   `:443` site (see the file's own comment for the
│                               #   real no-SNI-for-IP-literal bug this works
│                               #   around). caddy/certs/ (gitignored, mkcert,
│                               #   regenerated per-machine) is where the actual
│                               #   cert/key/root-CA files live -- see §9.
└── CLAUDE.md
```

## 4. Build order and status

### The v2 pivot (current, live product)

Owner decision (this session): stop iterating on an unproven proximity-payment
transport and ship a complete, working mock neobank first. Bump/BLE/offline
modes become parked v2-upgrade work (see below), not deleted. Server: ~55% of
the original code survives as-is (the ledger, locking discipline, adapter) —
that's the hard, adversarially-tested 55%. Mobile: the Expo project, gradle
config, dev-client build, and two-phone workflow survive; almost the entire
`src/` UI layer was rebuilt. Full trade-off writeup:
`docs/TapPay_v2_Technical_Design.md`.

- **Deliverable 0 — design doc + mockup.** STATUS: DONE. The technical
  design doc above, plus a published Artifact mockup (obsidian-and-metal
  visual direction, approved by the owner with three carried-forward notes:
  type-hierarchy consistency, a glass/blur button treatment instead of a flat
  gold gradient, and further background-motion iteration — all three were
  applied in Milestone 3/4 below, not left as mockup-only notes).

- **Milestone 1 — Server: park, then authenticate.** STATUS: BUILT AND
  TESTED. Proximity routes moved to `server/src/parked/` behind
  `ENABLE_PROXIMITY_ROUTES` (default off). New schema (migrations 012–016):
  `accounts.display_name`/`rib`, `customer_credentials`, `auth_sessions`,
  `beneficiaries`, `transfers`. JWT access tokens + rotating opaque refresh
  tokens with theft detection, argon2id password hashing, login lockout. New
  authed routes: `/me`, `/accounts/me/balance`, `/accounts/me/transactions`
  (keyset-paginated), `/transfers` (+ `/transfers/:txUuid`), `/lookup/rib/:rib`,
  full `/beneficiaries` CRUD. `MockBankAdapter` gained a `reference` field on
  `TransferContext` and writes a `transfers` row per settlement.
  `server/scripts/seed.ts` rewritten as the bank's provisioning system: 5 demo
  customers, ~15 backdated historical transfers, cross-referencing
  beneficiaries. Verified against a real running Postgres + Fastify server via
  both the automated suite and manual curl smoke tests (login → /me → balance
  → paginated history → beneficiaries, all against real seeded data).

- **Milestone 2 — Shared package.** STATUS: DONE. `packages/shared/src/rib.ts`
  (build/validate/format + IBAN derivation, ISO 7064 mod-97-10, tested against
  a real ISO 13616 cross-check) and `api.ts` (typed DTOs for every v2 route)
  added, additively — the original crypto/CBOR/COSE test surface is untouched
  and still passing.

- **Milestone 3 — Mobile foundation.** STATUS: DONE, TYPECHECKED, NOT YET
  DEVICE-VERIFIED. NativeWind v4 + expo-router +
  Reanimated 4/react-native-worklets + Moti + expo-haptics + expo-secure-store
  + expo-local-authentication + expo-font + `@expo-google-fonts/{fraunces,
  inter}` + expo-linear-gradient + expo-blur + expo-image-picker +
  `@tanstack/react-query` + `@shopify/flash-list` all added via `npx expo
  install` (SDK-57-compatible versions) or pinned `pnpm add`. `@gorhom/
  bottom-sheet` was added per the original plan but is NOT used by any
  screen yet — every step flow in Send is a full-screen step instead; treat
  it as available, not wired in. `@shopify/react-native-skia` was
  deliberately NOT added — the plan's "one deliberate use, drop if it
  doesn't hold 60fps on the A51" condition can't be evaluated without a
  device in this session, so the balance-card sheen ships as a static
  Reanimated-driven gradient glow (`ScreenBackground.tsx`) instead; adding
  Skia is a clean follow-up, not a blocker. Design tokens
  (`mobile/src/design/tokens.ts` + `palette.js`) mirror into
  `tailwind.config.js`. `AuthContext` implements the full state machine
  (password login → optional biometric-enrollment interstitial → signed in;
  biometric login refreshes and re-saves the rotated token; logout revokes
  server-side and wipes the biometric secure-store entry). `src/api/client.ts`
  does single-flight 401-refresh-and-retry.

- **Milestone 4 — Screens.** STATUS: BUILT, TYPECHECKED (`pnpm -r lint`
  clean across all three workspace packages), NOT YET RUN ON A DEVICE. Five
  screens: Sign-in (customer ID + password, biometric welcome-back state,
  post-login biometric-enrollment prompt), Home (masked balance with a
  persisted eye toggle, brushed card, FlashList transaction history,
  pull-to-refresh, real empty state), Send (recipient via saved contacts /
  live QR scan / typed RIB with mod-97 pre-send lookup / imported QR photo
  via `expo-camera`'s `scanFromURLAsync`, then amount, then reference, then
  review-and-confirm, with a client-generated `tx_uuid` that's idempotency-
  safe on retry), Profile (RIB + derived IBAN, a QR encoding
  `{rib, display_name}`, share-as-image and share-as-text, copy-RIB, sign
  out), Transaction detail (full receipt, share-as-image via
  `react-native-view-shot`, share-as-PDF via `expo-print` + `expo-sharing`).
  **What "not yet run on a device" means concretely**: no native rebuild
  (`npx expo run:android`) has been executed this round, so zero of the
  following are yet verified for real — Metro/NativeWind actually bundling
  cleanly, Reanimated 4's new-architecture requirement holding on the target
  phones, the biometric prompt actually firing via `expo-secure-store`'s
  `requireAuthentication`, live camera QR scanning, image-picker + QR
  decode-from-photo, share sheets, or PDF generation. Treat this milestone as
  "implemented and typechecked," not "working," until a real device run
  happens.

- **Milestone 5 — Docs.** STATUS: THIS REWRITE.

- **Verification.** STATUS: NOT STARTED. Needs, in order: (1) `docker compose
  up -d db` + `pnpm --filter server migrate` + full `pnpm -r test` including
  the parked suites, to confirm the v2 schema/routes didn't regress the
  original ledger tests; (2) `npx expo run:android` on a real phone --
  the dependency set changed enough this round (NativeWind, Reanimated 4,
  expo-router, half a dozen new native modules) that this is a real rebuild,
  not a Metro-only reload; (3) the live walkthrough: seeded sign-in → enable
  biometric → kill app → biometric re-entry → reveal balance → send to a
  saved contact with a reference (try all four recipient-input methods, not
  just one) → confirm settlement lands in both histories → verify directly
  against Postgres that the journal pair sums to zero and the `transfers`
  row carries the reference → share a receipt as image and as PDF → sign out
  → confirm the refresh token is revoked server-side and biometric re-entry
  is correctly refused.

### The Argent design direction (visual reskin shipped; prototype screens parked)

The "Argent" visual language -- a near-black `#0B0D10` ground with four slow
drifting radial-gradient blobs, translucent glass panels, a Newsreader
(serif display) + Schibsted Grotesk (grotesk UI) type pairing, near-
monochrome platinum/ink with no brand hue -- was commissioned as a clickable
Claude Design canvas prototype (`Argent Android.dc.html`) and approved. It
replaces the earlier "obsidian & metal" champagne-gold direction and
reverses two decisions that direction had recorded; both reversals are
written up in section 8 with their reasoning, not silently applied.

STATUS: RESKIN APPLIED to the five existing screens (sign-in, Home, Send's
5-step wizard, Profile, transfer receipt) and the seven shared components.
The prototype's *navigation and information architecture* were deliberately
NOT adopted -- this was a palette/type/panel reskin only, by explicit owner
scope decision ("just reskin for now, document the rest").

What exists: `mobile/src/design/palette.js` + `tokens.ts` carry the full
Argent token table; `Card.tsx` is a BlurView glass panel (with a `solid`
escape hatch for `ViewShot` captures); `GlassButton.tsx`'s `variant="primary"`
is a platinum gradient fill; `ScreenBackground.tsx` runs the four-blob field
on RN 0.86's native `experimental_backgroundImage` radial gradients,
drifting via Reanimated transforms on the UI thread (`ANIMATE_BLOBS` /
`BLOB_FIELD_OPACITY` are its tuning knobs). Route structure is unchanged:
the same three tabs (Home/Send/Profile), the same `Stack.Protected` auth
gate, the same five screens, the same API surface -- no new routes, no new
API calls.

What does NOT exist (designed in the prototype, never built -- each one
needs new routes and, where noted, new server work, so none of it was in
the reskin's scope):

- **5-icon bottom nav** (Home / Activity / a raised center Tap action /
  Receive / Profile). The live app is still the 3-tab
  `app/(tabs)/_layout.tsx`. Adopting this means new tab routes plus a
  custom `tabBar` for the raised center button.
- **Activity screen with a Spending-Insights tab** (bar chart by period +
  a by-payment-method breakdown). No route, no chart library, and no
  server aggregation endpoint -- `api.transactions` returns a keyset-
  paginated list only, so this needs a real backend addition, not just a
  screen. The heaviest of the six.
- **Standalone Contacts / beneficiaries picker screen.** The beneficiaries
  data and UI already exist as `ContactsList` inside `app/(tabs)/send.tsx`'s
  recipient step (backed by `api.beneficiaries` / `api.createBeneficiary`);
  the prototype promotes it to its own browsable/searchable screen.
  Cheapest of the six: extract the existing component, add a route, add
  search.
- **Confirm-before-send step.** Send's wizard already ends on a
  review-and-confirm step; the prototype adds a distinct full-screen
  confirmation surface with a slide/hold-to-send affordance. Would slot in
  as a sixth step in the existing `step` state machine -- no API change.
- **Standalone Receive / My-QR screen.** The QR, RIB, IBAN, copy-RIB,
  share-as-image, share-as-text and NFC-share are all already built inside
  `app/(tabs)/profile.tsx`; the prototype splits them onto their own
  Receive destination reachable from the nav. Mostly a move, not a build --
  but only makes sense together with the 5-icon nav.
- **Bottom action share-sheet.** `@gorhom/bottom-sheet` is already a
  dependency and still unused by any screen (see Milestone 3 above); the
  prototype's share actions live in a bottom sheet instead of the current
  inline button stacks in Profile and the receipt screen. This is the one
  item that could ship independently of the nav change.

**Rule for building any of these**: they are additive routes under `app/`,
not edits to the reskin. Do the nav change first if you're doing more than
one -- Activity, Receive and the center Tap action all assume the 5-icon
bar exists. Update this section's STATUS in the same change.

### The original P2P proximity-payment work (parked, not abandoned)

Everything below is real, was built and (where noted) device-verified before
the v2 pivot, and lives under `server/src/parked/` and `mobile/src/parked/`,
unregistered/unrouted by default. It resumes exactly where it left off
whenever proximity payments become the active milestone again — none of it
was invalidated by the pivot, it's just not what `app/` calls today.

- **M0 — Telemetry harness + bump-correlation spike.**
  STATUS: BUILT; EXIT GATE STILL NOT MET (unaffected by the v2 pivot).
  What exists: the harness (`telemetry/`, Docker, :8080), the on-device sensor
  stream, four real capture sessions (`telemetry/data/*.jsonl`), per-device
  peak-accel calibration for two Android models in
  `mobile/src/parked/config/sensorThresholds.ts`. What does NOT exist: the
  ~200-bump varied-grip/orientation session, an empirical R_AB distribution,
  or a ratified threshold policy. `docs/M0_correlation_results.md` is still a
  blank template. `telemetry/analysis/bump_model.py` still documents that a
  single fixed peak-accel threshold did not generalize across sessions.
  Blocked on: dedicated telemetry-capture time with both phones, now a
  scheduling question rather than a hardware-availability one (§7).

- **M1 — Server ledger + crypto foundation (original P2P version).**
  STATUS: BUILT AND VALIDATED ON REAL PHONES, PARKED. Postgres double-entry
  schema (still live, unchanged by the v2 pivot -- v2 sits on top of the same
  `journal`/`accounts` tables), `IBankAdapter` + `MockBankAdapter`,
  hardware-backed key generation, COSE_Sign1/CBOR signing, the reservation-
  expiry sweeper, server-side attestation cert-chain verification at
  enrollment, QR-code transport for `TxProposal`/`TxReceipt`. Real two-phone
  live verification (Galaxy S24 Ultra + Galaxy A51): StrongBox/TEE-backed
  enrollment, live camera-to-camera QR scanning in both directions,
  biometric-gated signing, correct ledger settlement confirmed directly
  against Postgres. All of this is now reachable only with
  `ENABLE_PROXIMITY_ROUTES=true` and the parked mobile screens.

- **M2 — Offline modes + reconciliation.**
  STATUS: BUILT, PARTIALLY DEVICE-VERIFIED, PARKED. Mode B (server-signed
  receipt relay) and Mode C (signed IOU persistence), `/tx/sync`, sequence-
  regression detection, freshness tokens, amber PENDING_INTENT UI, local
  SQLite queue, payee-side persistence mirror, `evaluateConnectivity()`
  auto-mode-detection. Mode A and Mode B ran live end-to-end on real hardware
  and settled correctly against Postgres; Mode C's full cycle (sign-and-
  queue, info-QR relay, reconnect-and-sync, payee amber→green flip) was
  never exercised live. The v2 app has no online/offline modes at all — this
  entire milestone is dormant until proximity payments resume.

- **M3 — QR-triggered BLE GATT transport.**
  STATUS: EARLY, UNVERIFIED ON A DEVICE, PARKED. The authenticated ECDH
  session layer (`packages/shared/src/crypto/session.ts`,
  `sessionTransport.ts`) is fully built and unit-tested (`ADV-07` automated
  against it), and was proven end-to-end on real hardware via the (now
  parked) `SessionDemoScreen.tsx`. The native GATT transport
  (`BleGattTransport.kt`, `BleTransportService.kt`) compiles clean but has
  never run on a real radio. Owner decision (recorded when this milestone
  was active): the BLE trigger is a QR scan naming a specific target device,
  not bump/motion-correlation — this decouples M3 from M0's blocked exit
  gate entirely, a decision that still stands whenever this milestone
  resumes. See the original spec (`docs/TapPay_Technical_Spec_v2.1.md`) and
  git history for the full detail this section used to carry; kept brief
  here since none of it is on the active critical path.

**Rule for reviving parked work**: flip `ENABLE_PROXIMITY_ROUTES=true`, wire
a screen back into `app/` (or restore an old-style screen switcher) that
imports from `mobile/src/parked/`, and update this section's STATUS lines in
the same change — don't silently un-park something without recording it here.

## 5. Non-negotiable invariants
Claude Code must never generate code that violates these. If a task appears to
require breaking one, stop and flag it.

**Ledger** (unchanged by the v2 pivot — the same `journal`/`accounts` schema
and `MockBankAdapter` back both the parked P2P routes and the live v2 routes)
- Every `tx_uuid`'s journal rows sum to exactly zero.
- Acquire row locks (`SELECT ... FOR UPDATE`) in strict lexicographical
  `account_id` order whenever two accounts are touched (`lockAccountsInOrder`).
  `accounts` and `devices` are separate lock targets; never hold both in the
  same transaction (see the parked `/tx/sync` admission/settlement split,
  `server/src/parked/routes/sync.ts`'s comment at the boundary, for why).
- Re-submitting the same `tx_uuid` is a no-op that returns the existing signed
  receipt/settlement (idempotent) — but ONLY if the resubmission is byte-
  identical to what created the row for the COSE-signed P2P path, or has the
  same `account_id`/`counterparty_account_id`/`amount`/`currency` for the v2
  `/transfers` path. `tx_uuid` is chosen by the client, so it is NOT scoped to
  a device or user: a different signer/caller reusing an in-flight or settled
  `tx_uuid` with different parameters must be rejected outright (`transfer()`
  checks this before the COMMITTED/RELEASED/HELD branches). Found via
  `/security-review` as a real settlement-slot-hijack vulnerability; see
  `server/src/adapters/MockBankAdapter.ts` and its test file, plus
  `server/src/parked/routes/__tests__/sync.test.ts` for the cross-mode case.
- A server-signed `TxReceipt` (parked P2P path only — v2's `/transfers`
  response has no separate receipt-fetch step, the settlement response IS
  the confirmation, scoped by the caller's own JWT `aid`) MUST name its
  intended payee and every verifier MUST check a scanned/fetched receipt
  against what it actually expects before trusting it. Bearer-token-shaped
  receipts are a settlement-forgery vector otherwise. Found via
  `/security-review`.
- Self-payment is structurally impossible at the ledger level —
  `journal`'s `UNIQUE (tx_uuid, account_id)` means such a transfer can't
  produce two rows. Reject it explicitly with a typed 4xx at every point
  that resolves a counterparty: the parked `/tx/submit`/`/tx/sync`, and v2's
  `POST /transfers` (`SelfPayment`) and `POST /beneficiaries` (rejecting a
  self-RIB beneficiary before it can even be selected as a recipient).
- Money is bigint minor units. No floats, no decimals-as-float — including in
  the mobile display layer (`mobile/src/design/format.ts`'s `formatMAD`
  formats `formatMinorUnits`'s bigint-exact string output; it never re-parses
  through a float for thousands-grouping).
- Expired `HELD` reservations must be released by the sweeper. Balance must
  never leak to abandoned holds.

**Auth (v2, live)** — `docs/TapPay_v2_Technical_Design.md` §6 has the full
state-machine writeup; this is the binding subset.
- Passwords are argon2id-hashed (`server/src/auth/passwords.ts`), OWASP
  baseline params, config-driven (never hardcoded). `verifyPassword` fails
  closed (returns false) on any internal error — never throws in a way that
  could be caught into an "allow" path.
- `POST /auth/login` returns exactly one generic 401
  (`InvalidCredentials`) for every failure mode — unknown `customer_id`,
  wrong password, locked account. Never let a new failure mode leak a
  distinguishing status code or message; this is what makes customer-id
  enumeration via login expensive rather than free.
- Refresh tokens are opaque, stored server-side as a SHA-256 hash only
  (never the raw token), and rotate on every use. Presenting a token that
  has already been rotated (`replaced_by` set, not just `revoked_at`) is a
  theft signal: it revokes the ENTIRE `family_id` chain, not just that one
  token. Do not weaken this to "just reject the reused token" — the whole
  point is that a stolen-and-later-used-by-someone-else token invalidates
  the legitimate holder's session too, forcing a re-login where the theft
  becomes visible.
- The refresh token, never the password, is what biometric re-entry unlocks
  (`expo-secure-store` with `requireAuthentication: true`). If a task
  proposes caching the password itself on-device in any form, stop and flag
  it — this is the one thing §1's biometric-login requirement explicitly
  must not do.
- Every v2 route that reads or writes account-scoped data (`/me`,
  `/accounts/me/*`, `/transfers`, `/beneficiaries*`) resolves the account
  from the JWT's `aid`/`sub` claims, never from a client-supplied id in the
  body or params. `/beneficiaries`' `owner_user_id` scoping is the concrete
  pattern every new authed route must follow (CLAUDE.md §10's client-
  suppliable-identifier pattern applies here exactly as it did to
  `device_id`/`tx_uuid` in the parked code).

**Crypto** (built for the parked P2P path; dormant in the live v2 app, whose
auth is JWT + argon2id instead — kept here verbatim because it's binding the
moment that code is un-parked, and because `packages/shared`'s crypto layer
is still compiled, tested, and exported)
- Identity signing keys are hardware-backed P-256 (StrongBox, TEE fallback),
  biometric-gated (`setUserAuthenticationRequired(true)`).
- The receiver nonce, `tx_uuid`, and timestamp MUST live inside the COSE_Sign1
  signed payload, not alongside it. Replay defense is cryptographic, not
  procedural.
- Verify COSE/CBOR against published third-party test vectors before trusting
  any transaction path (`packages/shared/src/crypto/__tests__/vectors/`: COSE
  Working Group's COSE_Sign1 suite, Wycheproof for ECDSA-P256/SHA-256 p1363).
- Device attestation cert chains are verified server-side at enrollment
  against Google roots. Never store an unverified attestation blob as
  trusted.
- **Authenticated session ECDH.** Ephemeral P-256 public keys MUST be signed
  by the hardware identity key and verified against the peer's enrolled
  `identity_pubkey` before any shared secret is derived; the transcript MUST
  be bound into the HKDF `info`; anonymous ECDH is forbidden, including as an
  error fallback. `session.ts`/`sessionTransport.ts` implement this,
  `ADV-07` is automated against it, and it was validated on real hardware
  (two identities on one phone, real biometric signing, real network
  fetch+verify, real AES-GCM round trip) before the pivot.
- **Foreground-service type** for the connection-holding BLE service: not
  wired to an actually-running foreground service yet (`BleTransportService`
  exists structurally, doesn't call `startForeground()`).

**Mode C (offline IOU) — parked, binding if resumed**
- UI shows AMBER PENDING_INTENT only. Never a green checkmark until server
  settlement.
- A payee's phone has no way to verify a peer's identity-key signature
  offline; a received offline claim is an UNVERIFIED ASSERTION. Green only
  after independently fetching and verifying the server-signed receipt.
- Local Mode C persistence (`mobile/src/parked/db/offlineIntents.ts`) is
  plain, unencrypted expo-sqlite — a deliberate scope decision (the stored
  payload's security property is integrity, from the signature, not
  confidentiality), not an oversight. SQLCipher is a named future follow-up.
- The client's local `device_seq` counter is NOT a security control. Only
  the server's `devices.last_seq` is authoritative.

**Sensor gate — parked, binding if resumed**
- R_AB >= 0.80 is a TUNABLE BASELINE, not a constant. Thresholds live in
  config, never hardcoded.
- Whether a scalar threshold gate is sufficient at all is still an open
  question (`telemetry/analysis/bump_model.py`'s jerk-feature note).

## 6. Platform / tooling constraints
- **No Android Studio.** Toolchain only: JDK 17, Android SDK `cmdline-tools`,
  `platform-tools` (adb), `build-tools`, platform `android-35`. `ANDROID_HOME` set.
- **Native module uses the Expo Modules API** (`expo.modules.tappay.*`). Do NOT
  scaffold raw TurboModule/New-Architecture boilerplate.
- **Expo Go cannot run this.** Biometrics, the camera, and (when un-parked)
  BLE/100Hz sensors/StrongBox/foreground services all require a custom
  dev-client build (`npx expo run:android`). Expo Go is only for pure-UI
  iteration with no native calls — and even then, NativeWind/Reanimated 4
  need the dev-client's native bits, so plan on a real build for almost any
  UI change now.
- **New Architecture is required, not optional, as of the v2 pivot.**
  `app.json` sets `"newArchEnabled": true` explicitly. `react-native-
  reanimated@4` delegates its worklet transform to `react-native-worklets`
  (babel plugin `react-native-worklets/plugin`, listed last in
  `babel.config.js`) and requires the New Architecture to function at all —
  do not downgrade Reanimated or flip New Architecture off without also
  reworking the animation layer.
- **Android 12+ runtime BLE permissions** (only relevant once the parked BLE
  work is un-parked): `BLUETOOTH_SCAN` (`neverForLocation`),
  `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`, plus a foreground-service type
  declaration for the connection-holding service on Android 14/15.
- **Postgres 16 runs in Docker** via docker-compose (pgAdmin optional). Schema
  changes go through versioned migrations. Never hand-run DDL against a live db.
- **Release builds are signed** with a dedicated keystore. Debug-only signing is
  not "production grade."
- **Secrets never ship in the app binary** except the pinned server *public*
  key (`mobile/src/parked/config/serverPublicKey.ts`, used only by the parked
  COSE-receipt-verification path) and `JWT_SECRET` (server-only, never
  bundled into the app — the app never sees or needs it; it only ever
  presents a Bearer token the server itself signed).

## 7. Definitions
- **The seam**: `IBankAdapter`. Swapping the mock ledger for a real bank must
  require zero changes above this interface. `TransferContext`'s
  `recipientDeviceId`/`receiverNonce`/`reference` are all optional — v2's
  `/transfers` route only ever supplies `reference`; the parked P2P path only
  ever supplies the device fields; neither breaks the other.
- **200ms target** (parked, relevant only if M3 resumes): elapsed time from a
  QR-scan trigger to a successful phone-to-phone BLE connection.
- **Two-phone testing**: a Galaxy S24 Ultra (`SM-S928B`) and a Galaxy A51
  (`SM-A515F`) are both available over Wi-Fi adb. Used to validate the
  original P2P milestones live; not yet used for a live v2 walkthrough (§4's
  Verification entry). Every QR scan step still has a manual paste/typed
  fallback in the live app (Send's "Type RIB" method serves the role the old
  `qrFlow.tsx` paste fallback used to), useful for one-phone iteration.

## 8. Conventions
- Server: Node.js + Fastify + TypeScript. Prefer explicit types on all money
  and crypto/auth boundaries.
- Config over constants for every tunable (thresholds, TTLs, latency
  injection, JWT/argon2/lockout/rate-limit parameters — see `server/src/
  config.ts`, which is the single source for all of it, including the v2
  auth block).
- Errors are typed and surfaced, never swallowed. Fail closed on any
  signature, balance, password-verification, or attestation check.
- Import-extension convention (unchanged): files inside `packages/shared`
  import each other with a literal `.js` extension on `.ts` source files,
  required for Node/tsx ESM resolution under that package's `"type":
  "module"`. Do not "correct" these to extensionless or `.ts`.
- `mobile/metro.config.js` still carries the three original load-bearing
  workarounds (`watchFolders` at the repo root, `unstable_enableSymlinks`,
  the `.js`→`.ts` resolveRequest fallback for `packages/shared` imports) —
  now wrapped in `withNativeWind(config, { input: './global.css' })`, added
  after those, not replacing them.
- **NativeWind / design tokens.** `mobile/src/design/palette.js` is the one
  raw color/radius source, written as plain CommonJS specifically so
  `tailwind.config.js` (executed under plain Node, no TS/babel transform)
  can `require()` it directly. `mobile/src/design/tokens.ts` re-exports the
  same values (plus type scale and spacing, which have no reason to exist in
  Tailwind's config) for the TypeScript app code. If you add a color, add it
  to `palette.js`, not `tokens.ts` — `tokens.ts` importing from `palette.js`
  is what keeps NativeWind classes and raw `StyleSheet`/Reanimated values
  reading the same numbers. `mobile/tsconfig.json` explicitly excludes
  `tailwind.config.js` from `tsc --noEmit` (mirroring Expo's own exclusion of
  `babel.config.js`/`metro.config.js`) — its `require()` of a plain-JS module
  isn't meant to typecheck as an ES module.
- **`nativewind@4.2.6` hard-requires Tailwind CSS v3 at runtime, despite the
  version number suggesting v4 compatibility.** `nativewind/dist/metro/
  tailwind/index.js` checks `tailwindcss/package.json`'s version string and
  throws `"NativeWind only supports Tailwind CSS v3"` for anything else —
  this is not a config issue, it's unconditional in this installed version.
  Found live: the first native build this pivot ran compiled and installed
  cleanly (Gradle has no opinion on this), but Metro crashed on startup with
  exactly that error, because `tailwindcss@^4.3.3` was installed initially.
  Fixed by pinning `tailwindcss@^3.4.19` and using v3's three-directive
  `global.css` (`@tailwind base; @tailwind components; @tailwind utilities;`)
  instead of v4's single `@import "tailwindcss";`. `tailwind.config.js`
  itself needed no change — it was already written in v3-compatible
  CommonJS `module.exports` form. Do not "upgrade" `tailwindcss` back to v4
  without first confirming a NativeWind release that actually removes this
  check.
- **The primary button is a platinum gradient fill; everything else is
  glass. This is a recorded reversal, not drift.** The obsidian era
  deliberately used a blurred translucent surface with a thin *gold*
  gradient border, because the mockup round's owner feedback was that a flat
  *gold* gradient fill "reads as too AI-generated." The Argent direction
  (§4) reverses that specifically for `GlassButton`'s `variant="primary"`,
  which is now a solid `platinumLight → platinumMid(52%) → platinumDeep`
  `LinearGradient` with `ink` (`#1B1E23`) text and no blur. The distinction
  that makes this not the same mistake: the rejected fill was a saturated
  brand hue used as paint; platinum is a neutral metal whose whole job is to
  be the single brightest object on a monochrome ink field. `variant="ghost"`
  and `variant="danger"` keep the `expo-blur` glass treatment (now a flat
  1px hairline border instead of a gradient border, since Argent's borders
  are flat, not metallic). **Corollary rule: at most one platinum button
  per screen.** Secondary actions (Cancel, Save as contact, View receipt,
  Share as text, Share via NFC) and `SegmentedControl`'s active segment stay
  glass — platinum everywhere is how this direction degrades into noise.
- **Type hierarchy is a fixed scale, not a per-screen choice.**
  `mobile/src/design/tokens.ts`'s `type` object is the complete set of roles
  (hero, screenTitle, sectionLabel, body, bodyStrong, caption, amount) — every
  screen pulls from it rather than hand-picking a font size/weight, which is
  what the mockup round's "Fraunces only on hero elements" inconsistency
  feedback was about. Under Argent, Newsreader (200/300 weight) owns `hero`
  and `screenTitle`; Schibsted Grotesk (400/500/600) owns everything else —
  including `amount`, which deliberately moved off the display serif onto a
  grotesk with `tabular-nums`, since a right-aligned scrolling amount column
  needs tabular digit alignment a 200-weight serif can't give.
- **`tokens.ts`'s `as { ... }` cast must be updated whenever a key is
  removed or renamed in `palette.js`.** The cast (not an inferred type)
  means deleting a color from `palette.js` produces ZERO `tsc` errors —
  every `colors.thatKey` keeps typechecking and ships as `undefined` at
  runtime. Renaming or removing a token is always a two-file edit; do the
  `tokens.ts` cast in the same commit so `tsc --noEmit` surfaces every stale
  call site instead of silently shipping a black-on-black label.
- **The background is animated, and that reverses a device-test decision —
  deliberately, with a performance gate.** `ScreenBackground.tsx` previously
  carried an explicit "NOT animated -- device testing found the drifting
  glow gimmicky" note. That referred to a gold sheen sweeping across the
  balance card, a decorative highlight competing with the number the user
  came to read. Argent's four background blobs (§4) are a different
  mechanism: large, low-opacity, sitting behind blurred glass, drifting on
  24-32s cycles; only `transform` animates, on the UI thread via Reanimated,
  over `experimental_backgroundImage` radial gradients that rasterize once.
  UNVERIFIED ON THE A51 (`SM-A515F`) as of this writing — the load-bearing
  test is Home with the `FlashList` scrolling under the blobs. Same rule
  that dropped Skia elsewhere in this app applies here: if it doesn't hold
  60fps, flip `ANIMATE_BLOBS` to `false` first, then reduce the blob count.
  `BLOB_FIELD_OPACITY` is the contrast knob if bare text over a blob center
  (the Home greeting, the sign-in tagline, empty-state copy) reads weak. Do
  not ship a janky background.
- **RN 0.86's New Architecture unlocks CSS-parity style props this app now
  relies on.** `boxShadow` (array-of-layers, `inset` supported but needs
  Android 10+) and `experimental_backgroundImage` (with a `'radial-gradient'`
  type, supported on both platforms in this RN version — note the
  `experimental_` prefix is what actually typechecks here) back the Argent
  glass panels and background blobs with no SVG/Skia dependency. `filter:
  blur` is deliberately NOT used anywhere — it's Android-12+-only and
  unavailable on iOS at all; blob softness instead comes from a transparent
  outer `radial-gradient` stop, which is a strict cross-platform win.
- **Direction (credit/debit) color is de-hued from the obsidian era's
  green/bone pair, on purpose.** Amounts encode direction via the sign glyph
  plus a brightness delta (`creditText` `#DFE6EE` vs `textPrimary`), plus a
  chip tint (`creditTint`) borrowed from Argent's own teal background blob
  at 16% opacity, used only as a small fill, never as text. The old
  `#4E9E7A` green was a real hue in an otherwise monochrome system and was
  dropped; full monochrome (matching the prototype's six hand-picked static
  rows) was also rejected, because Home's transaction list is a real
  scanning surface over paginated data, not a hero screen, and stripping
  the direction signal entirely has a real product cost. `danger` stays a
  hue — failure signalling is functional, not decorative, and is exempt
  from Argent's "no accent hue" rule.
- `api.ts` (`packages/shared/src/api.ts`) is hand-kept in sync with the
  server route handlers, not generated from them. When you change a v2 route's
  request/response shape in `server/src/routes/*.ts`, update the matching
  interface in `api.ts` in the same change — nothing enforces this
  automatically.
- Keep this CLAUDE.md current, in the same change that makes it stale (§8's
  own long-standing rule, unchanged): build/test/lint commands → §9; a
  milestone's status → §4; an invariant becoming real/untrue/exception → §5;
  a new top-level directory or package → §3.

## 9. Commands
```bash
# Infra (everyday)
docker compose up -d db              # postgres 16 on host :5433 (not 5432)
docker compose up -d redis           # backs @fastify/rate-limit's distributed store
docker compose up -d telemetry       # only needed for the parked M0 harness
docker compose up -d pgadmin         # optional, :5050
docker compose up -d prometheus grafana  # observability (Ship List Phase 2) --
                                      # Prometheus :9090 scrapes the host-run
                                      # server's GET /metrics; Grafana :3300
                                      # (not :3001/:3002/:3003 -- same WSL2
                                      # host-port collision as :5432 above)
                                      # auto-provisions the "TapPay Ledger"
                                      # dashboard from ops/grafana/. Grafana
                                      # login: admin / tappay (dev-only).

# TLS (Ship List Phase 4, ADR-0009) -- first-run bootstrap, and again
# whenever the dev host's LAN IP changes (see serverUrl.ts's own comment):
mkdir -p caddy/certs
mkcert -cert-file caddy/certs/server.pem -key-file caddy/certs/server-key.pem \
  <your-LAN-IP> localhost 127.0.0.1 host.docker.internal
cp "$(mkcert -CAROOT)/rootCA.pem" caddy/certs/rootCA.pem   # for curl --cacert / device trust
docker compose up -d caddy           # TLS on :443 -- fails loudly if certs are missing

# Server -- first-run bootstrap (required once)
cp .env.example .env
# .env MUST also set JWT_SECRET (any non-empty string in dev; the server
# fails fast at startup without it -- config.ts's envRequired()).
pnpm --filter server generate-server-key   # writes server/keys/server_identity.pem
# ^ only needed if/when the parked COSE-receipt path is re-enabled; the live
#   v2 app doesn't use this key at all.

# Server -- everyday
pnpm --filter server migrate     # node-pg-migrate up -- applies 001-017
pnpm --filter server seed        # provisions 5 demo customers, see below
pnpm --filter server dev
pnpm --filter server test        # requires db up + migrations applied.
                                  # includes the parked suites automatically
                                  # (they call buildApp({proximityRoutes:true})
                                  # per-test, independent of ENABLE_PROXIMITY_ROUTES)
pnpm --filter server check-invariants  # one-shot ledger invariant check, JSON + exit 1 on violation
pnpm --filter server restore-drill     # Ship List Phase 3: dumps the real dev db, restores into a
                                  # throwaway container, runs checkLedgerInvariants() against it,
                                  # logs a dated row to ops/RESTORE_DRILL.md. Cleans up after itself
                                  # even on failure.
docker compose --profile chaos up -d toxiproxy  # required before chaos-experiment (below) --
                                  # not started by a plain `docker compose up`
pnpm --filter server chaos-experiment  # Ship List Phase 3: injects latency + connection-reset
                                  # (via toxiproxy) and a real `docker compose kill -s SIGKILL db`
                                  # during bursts of real transfers, checks invariants after each,
                                  # logs to ops/CHAOS_LOG.md. This is what found incident 0005
                                  # (docs/incidents/) -- an unhandled pg.Pool error crashing the
                                  # whole server on a database restart, since fixed.

# Demo login (after `pnpm --filter server seed`):
#   customer_id: 10000001 .. 10000005   password: Demo#2026 (same for all)

# Shared crypto/wire/API package
pnpm --filter @tappay/shared test   # note the scope: `--filter shared` doesn't resolve
pnpm --filter @tappay/shared lint   # tsc --noEmit

# Everything CI runs, in one shot
pnpm -r lint && pnpm --filter server migrate && pnpm -r test

# Mobile (dev-client build to a plugged-in phone) -- treat this as a REAL
# rebuild after this session's dependency changes (NativeWind, Reanimated 4,
# expo-router, half a dozen new native modules), not a Metro-only reload.
npx expo run:android             # builds + installs dev client APK
adb reverse tcp:3000 tcp:3000    # or use the LAN-IP approach in serverUrl.ts
pnpm --filter @tappay/mobile lint
# NOTE (unchanged from before the pivot): `adb reverse --remove` doesn't
# close an already-open keep-alive connection -- a live "go offline" test
# needs a full app restart after removing the port forward.

# Telemetry harness (parked-adjacent, Docker only)
docker compose up -d telemetry
docker compose exec telemetry python -m analysis.compute_correlation data/1.jsonl
```

## 10. Testing
- Adversarial suite (parked P2P path — unaffected by the v2 pivot, still runs
  via `pnpm --filter server test`):
  - ADV-01 replay, ADV-01b settlement-slot hijack, ADV-02 amount tamper,
    ADV-03 rollback spend, ADV-06 deadlock stress — all AUTOMATED, all still
    passing, all under `server/src/parked/routes/__tests__/` or
    `server/src/adapters/__tests__/MockBankAdapter.test.ts` (which stays
    live/unparked since the ledger itself didn't move).
  - ADV-04/ADV-05 — LIKELY MOOT (motion-trigger-specific failure modes, moot
    under the QR-scan-trigger decision), left listed rather than deleted.
  - ADV-07 MITM relay — AUTOMATED against `session.ts` directly, no radio
    needed.
- v2 route test coverage (`server/src/routes/__tests__/`): `auth.test.ts`
  (login success/lockout/generic-failure-message, refresh rotation, reuse-
  after-rotation revokes the family, logout revocation), `me.test.ts`
  (`/me`, balance, keyset-paginated transaction history including a
  submitted-vs-seen-set pagination correctness check), `transfers.test.ts`
  (settlement by RIB and by beneficiary id, self-payment rejection, unknown/
  invalid RIB, idempotent resubmission, cross-customer beneficiary-id
  rejection, RIB lookup including the "unknown vs malformed both 404
  identically" no-enumeration check), `beneficiaries.test.ts` (full CRUD +
  cross-customer scoping). `v2TestHelpers.ts` provisions test customers
  directly then logs in through the real `/auth/login` route, so every test
  exercises genuine Bearer auth rather than a bypassed session.
- `packages/shared/src/__tests__/rib.test.ts`: build/validate/tamper-
  detection/format/IBAN-derivation, including a real ISO 13616 cross-check.
- Mobile has no test runner (`lint` is `tsc --noEmit` only) — same as before
  the pivot. The five v2 screens are typechecked but not yet exercised on a
  device or in a component test; treat any behavioral claim about them as
  unverified until the Verification step in §4 runs. The Argent reskin
  (§4) is in the same state after this round — `pnpm --filter @tappay/mobile
  lint` is clean, but the animated background's A51 performance, the
  `Card`'s `solid`-prop ViewShot regression path, and every contrast/
  legibility judgment are all visually unverified until a real device
  walkthrough happens.
- Run `/security-review` on any change touching signing, ECDH, JWT/refresh-
  token issuance, argon2 password handling, the SQL locking code, the sync/
  reconciliation path, or any route that keys durable state on a client-
  chosen identifier (`tx_uuid`, `device_id`, `customer_id`, a nonce, a
  refresh token) — this is now a confirmed recurring pattern across both the
  original P2P code AND the v2 auth system (a client-chosen or attacker-
  suppliable identifier insufficiently bound to what it should be scoped to).

## 11. Known security gaps, accepted for MVP, with reasons
Deliberately deferred, not overlooked. Do not "fix" one of these
opportunistically mid-task.

- **D1 — No TLS — CLOSED for local dev/demo (Ship List Phase 4, ADR-0009).**
  A `caddy` service (`docker-compose.yml`, `Caddyfile`) now terminates TLS on
  `:443` in front of the host-run server, using a locally-issued mkcert
  certificate (`caddy/certs/`, gitignored, regenerated per-machine).
  `mobile/src/config/serverUrl.ts` connects via `https://` by default.
  Verified end-to-end: a real login through the proxy, a connection without
  the mkcert root CA correctly rejected, a fresh container with no cert yet
  failing loudly rather than silently serving plaintext. What's still
  open: Android doesn't yet trust the mkcert CA (a one-time per-device step,
  `mobile/DEVICE_TEST_MATRIX.md`, Ship List Phase 6) or pin the cert
  (Ship List Phase 5) — until then, a real device connection will correctly
  reject the certificate as untrusted, which is the expected intermediate
  state, not a bug. A real deployment replaces the mkcert cert with a real
  CA (ADR-0009's revisit trigger), not this proxy architecture.
- **D2 — No auth on the two remaining unauthenticated GET routes**
  (`server/src/routes/tx.ts`'s balance-by-id and receipt-by-tx_uuid, kept
  live only for the parked P2P path). Every v2 route is authenticated; this
  gap is now narrower than before the pivot, not wider.
- **D3 — Enrollment's unverified email binding — CLOSED for the live app,
  not fixed.** The original vulnerability (enrolling a device against
  `email=victim@example.com` with zero ownership proof) lived in
  `server/src/parked/routes/devices.ts`'s `/devices/enroll`, which is now
  parked and unreachable by default. It's closed because the vulnerable
  code path isn't live, not because the underlying design flaw was
  resolved — if `ENABLE_PROXIMITY_ROUTES` is ever flipped on in a real
  deployment, this gap is back and still unfixed. v2's actual account
  creation has no equivalent flow at all: accounts only exist via
  `seed.ts`'s bank-provisioning script, which is a trusted, offline,
  operator-run process by construction.
- **D4 — Mode C's `OfflineIou` carries no receiver-side nonce.** Unchanged,
  parked along with the rest of Mode C.
- **D6 — v2 auth has no email/SMS-based password reset or account recovery.**
  There is no "forgot password" flow anywhere in the app — matches §1's "no
  self-service" model (a real bank's call center or branch would handle
  this out-of-band), but is worth naming explicitly since a real product
  would need one before launch.
- **D7 — Only `/auth/login` and `/lookup/rib/:rib` are rate-limited among
  v2 routes.** `/transfers`, `/beneficiaries*`, `/accounts/me/*` have no
  per-route limit beyond the global backstop (`rateLimitGlobalMax`).
  Acceptable for MVP (all are JWT-authenticated, so abuse is attributable
  and revocable), but a real deployment would want per-route limits on
  `/transfers` specifically before launch.
- **D5 — Attestation revocation / verified-boot state, SQLCipher at-rest
  encryption for Mode C, iOS, a real bank adapter, multi-currency, KYC/AML,
  an ops console.** Unchanged from before the pivot, already named as
  deferred elsewhere in this document.

## 12. Out of scope for MVP
iOS build and Swift native module; real payment rails / real funds;
multi-currency; production banking compliance (PCI DSS, EMVCo);
self-service account creation. BLE/bump/proximity payments and online/
offline settlement modes are explicitly OUT of the current MVP's scope —
not because they're a bad idea, but because they're the parked v2-upgrade
work described in §4. Design decisions in the live app must not preclude
resuming that work (the `IBankAdapter` seam, the untouched ledger schema,
and the fact that nothing was deleted are what keep this true), but do not
implement or extend it now.
