# TapPay — Project Context (CLAUDE.md)

## 1. What this is
P2P proximity payment app. Two phones are bumped together; a fused multi-sensor
signal (BLE RSSI + magnetometer + accelerometer + gyroscope) binds the physical
tap to a cryptographically signed transaction over a local BLE GATT channel.
No NFC, no HCE, no Secure Element card emulation anywhere in this project.

Backend is a MOCK neobank (double-entry ledger). It moves no real money.
Never connect this to real funds without a banking license (Bank Al-Maghrib).
Currency is MAD. All monetary values are integer minor units (centimes) as
bigint. Floating point for money is forbidden anywhere in the stack.

## 2. Scope
- MVP target platform: Android only.
- iOS is architecturally compatible (nothing here depends on NFC/HCE) and is a
  future target, but is OUT OF MVP SCOPE. Do not write Swift or attempt iOS
  builds. Known future constraint to design around, not solve now: iOS Core
  Bluetooth restricts peripheral-mode advertising in the background.
- Do not build any real payment-rail integration. The `IBankAdapter` seam is the
  only place a real bank would ever plug in.

## 3. Repository layout (monorepo)
```
tappay/
├── docker-compose.yml         # postgres 16 (host :5433), pgadmin, telemetry
├── pnpm-workspace.yaml        # members: server, mobile, packages/shared
├── docs/                      # TapPay_Technical_Spec_v2.1.md, Build_Guide, M0_correlation_results
├── packages/shared/           # @tappay/shared -- crypto + wire-format package.
│   └── src/                   #   COSE_Sign1, CBOR codecs, P-256 ECDSA, DER<->raw
│                              #   conversion, every signed payload type,
│                              #   IBankAdapter interface. ~90% of the repo's
│                              #   tests live here (server + mobile both import
│                              #   it via `workspace:*`; it has no ECDH yet, see §5).
├── server/                    # @tappay/server -- Node.js/Fastify mock neobank + ledger
│   ├── migrations/*.cjs       # node-pg-migrate, applied in numeric order
│   ├── scripts/               # seed.ts, generate-server-key.ts (see §9 bootstrap)
│   └── keys/                  # server_identity.pem -- GITIGNORED, generate locally
├── mobile/                    # @tappay/mobile -- React Native (Expo) app
│   ├── metro.config.js        # workspace symlink + .js->.ts resolver shim (§8)
│   ├── src/                   # UI, screens, local SQLite queue, QR transport, config
│   │                          #   (crypto lives in packages/shared, not here)
│   └── modules/tappay-native/ # Expo Modules API native code (Kotlin)
├── telemetry/                 # Python FastAPI + Chart.js harness (Docker only, see §9)
│   ├── app/main.py            # the actual entrypoint -- not telemetry/server.py
│   ├── analysis/               # compute_correlation, bump_separability, bump_model
│   └── data/*.jsonl           # captured sessions, gitignored
└── CLAUDE.md
```

## 4. Build order (risk-first intent, with the real, owner-approved sequencing)
The order below exists so the riskiest physical assumption gets validated before
downstream layers depend on it. That intent still stands. The literal
"finish a milestone's gate before touching the next" sequencing has been
consciously relaxed by the project owner (bump testing needs a second physical
phone that wasn't available), and the status lines below record what actually
happened so a future agent doesn't mistake the deviation for a bug, and doesn't
"fix" it by inventing data to satisfy a gate.

**Rule for deviating**: a milestone gate may be deferred, never silently
skipped. If you proceed past an unmet exit criterion, say so explicitly, record
what's still unproven, and name what downstream work becomes provisional as a
result. Update the status lines below in the same change.

- **M0 — Telemetry harness + bump-correlation spike.**
  STATUS: BUILT; EXIT GATE DEFERRED BY OWNER DECISION, NOT MET.
  What exists: the harness (`telemetry/`, Docker, :8080), the on-device sensor
  stream, four real capture sessions (`telemetry/data/*.jsonl`, ~20 bumps each),
  and real per-device peak-accel calibration for two Android models in
  `mobile/src/config/sensorThresholds.ts`.
  What does NOT exist: the ~200-bump varied-grip/orientation session, and
  therefore no empirical R_AB distribution and no ratified threshold policy.
  `docs/M0_correlation_results.md` is still a blank template — treat it as an
  open TODO. Never backfill it with anything but real measured data.
  What the partial data already showed, and must not be forgotten:
  `telemetry/analysis/bump_model.py` documents that a single fixed peak-accel
  threshold did NOT generalize across sessions (session 4: 6 of 13 real bumps
  missed). Per-device thresholds are already required, and a scalar-threshold
  gate alone may not be sufficient. Treat the M3 qualification gate's
  *architecture*, not just its constants, as still unproven.
  Blocked on: a second physical Android device. One Galaxy S24 Ultra
  (`SM-S928B`) is available; `sensorThresholds.ts` also carries a calibrated
  `SM-A515F` (Galaxy A51) row, so if that phone is still reachable the gate may
  be closer than the blank results doc suggests.

- **M1 — Server ledger + crypto foundation.**
  STATUS: BUILT AND VALIDATED ON A REAL PHONE.
  Postgres double-entry schema, Fastify server, `IBankAdapter` + `MockBankAdapter`
  (artificial 200–800ms latency + fault injection). Hardware-backed key generation
  (Kotlin `KeyStoreManager`), COSE_Sign1/CBOR signing (TS, in `packages/shared`).
  Reservation-expiry sweeper. Server-side attestation cert-chain verification at
  enrollment. QR-code fallback transport.
  Exit met, with one caveat: the end-to-end payment was proven on ONE physical
  phone via the QR paste fallback (see §7's one-phone note), not two phones
  scanning each other live.

- **M2 — Offline modes + reconciliation.**
  STATUS: BUILT.
  Mode B (server-signed receipt relay) and Mode C (signed IOU persistence),
  `/tx/sync`, sequence-regression detection, freshness tokens, amber
  PENDING_INTENT UI, local SQLite queue, payee-side persistence mirror.
  Exit: airplane-mode tap creates a local IOU; reconnect settles it on the ledger
  with no UI falsehood. Met on the payer side; the payee-side amber→green flip
  is code-verified and test-covered but not yet demonstrated live across two
  physical devices (queued for the second phone).

- **M3 — Motion engine + BLE GATT transport.**
  STATUS: NOT STARTED, except the authenticated ECDH session layer (§5), which
  was built ahead of the rest of M3 by owner decision — it needed neither bump
  data nor BLE hardware, unlike everything else below. `ADV-07` is automated
  against it already (see §10); it is not yet wired into any transport.
  Kotlin `MotionEngine` (100Hz ring buffer, spike detect, 2-channel cross-corr),
  `MagEngine`, low-latency GATT server/scanner, RSSI convergence filter, GATT
  clock sync.
  Exit: bumping two foregrounded Android phones binds intent and settles over BLE
  within the 200ms target.
  Hard prerequisite for the radio/motion half: a second physical phone. Also
  revisit M0's open question (above) before committing to a threshold-only
  qualification gate.

## 5. Non-negotiable invariants
Claude Code must never generate code that violates these. If a task appears to
require breaking one, stop and flag it.

**Ledger**
- Every `tx_uuid`'s journal rows sum to exactly zero.
- Acquire row locks (`SELECT ... FOR UPDATE`) in strict lexicographical
  `account_id` order whenever two accounts are touched (`lockAccountsInOrder`).
  Two distinct lock targets exist as of M2: `accounts` (balance-affecting
  operations) and `devices` (`/tx/sync`'s `last_seq` / `rollback_flagged_at`).
  Never hold both in the same transaction — see the admission/settlement split
  below, which is what keeps them separate. If a third lock target is ever
  added, define its ordering here first.
- `/tx/sync` MUST keep admission and settlement as two separate, sequential
  transactions. The admission transaction (lock the device row, insert the
  PENDING `offline_intents` audit row, check seq + freshness, advance
  `last_seq`) must COMMIT before `bankAdapter.transfer()` is called. Never nest
  `transfer()` inside it: inserting into `offline_intents` takes an implicit
  FK-check lock on the referenced `accounts` row, and `transfer()`'s own
  transaction then blocks on `SELECT ... FOR UPDATE` of that same row — a
  guaranteed self-deadlock, not a race. See `server/src/routes/sync.ts`'s
  comment at the admission/settlement boundary.
- Re-submitting the same `tx_uuid` is a no-op that returns the existing signed
  receipt (idempotent) — but ONLY if the resubmission is the byte-identical
  signed message that created the row. `tx_uuid` is chosen by whoever signs, so
  it is NOT scoped to a device: a different signer reusing an in-flight or
  settled `tx_uuid` must be rejected outright, never resumed and never handed
  the original's receipt. Any new idempotent path must compare the stored
  signed bytes, not just the key. (Found via `/security-review` as a real
  settlement-slot-hijack vulnerability; see `server/src/routes/sync.ts` and its
  test file.)
- Self-payment (sender and recipient resolving to the same account) is
  structurally impossible at the ledger level — `journal`'s
  `UNIQUE (tx_uuid, account_id)` means such a transfer can't produce two rows.
  Reject it explicitly, with a typed 4xx, at every point that resolves a
  counterparty (`/tx/submit`, `/tx/sync`, and any client-side recipient
  picker). Do not relax the constraint to "fix" this — the constraint is what
  makes double-journaling impossible in the first place.
- Money is bigint minor units. No floats, no decimals-as-float.
- Expired `HELD` reservations must be released by the sweeper. Balance must never
  leak to abandoned holds.

**Crypto**
- Identity signing keys are hardware-backed P-256 (StrongBox, TEE fallback),
  biometric-gated (`setUserAuthenticationRequired(true)`).
- The receiver nonce, `tx_uuid`, and timestamp MUST live inside the COSE_Sign1
  signed payload, not alongside it. Replay defense is cryptographic, not
  procedural.
- Verify COSE/CBOR against published third-party test vectors before trusting
  any transaction path. Concretely, the corpus in
  `packages/shared/src/crypto/__tests__/vectors/`: the COSE Working Group's
  `cose-wg/Examples` COSE_Sign1 suite, and Google/C2SP Wycheproof for
  ECDSA-P256/SHA-256 in raw p1363 (r||s) form. (The v2.1 spec and an earlier
  draft of this file say "NIST vectors" — no NIST CAVP vectors are used or
  needed; Wycheproof's malleability/edge-case coverage is stronger for this
  purpose. Don't swap toward CAVP on the strength of the old wording.)
- Device attestation cert chains are verified server-side at enrollment against
  Google roots. Never store an unverified attestation blob as trusted.

**Invariants for code that does not exist yet (M3)**
These are binding on the code once it's written; they are NOT violations today.
Do not "fix" them by building the component early outside of a planned,
recorded deviation (§4's rule for deviating) — the authenticated ECDH layer
below is the one deliberate exception, being built ahead of the rest of M3.
- **Authenticated session ECDH.** When the BLE GATT channel is built, ephemeral
  P-256 public keys MUST be signed by the hardware identity key and verified
  against the peer's enrolled `identity_pubkey` (fetched via a server-signed
  device credential, not trust-on-first-use) before any shared secret is
  derived. The transcript (both ephemeral pubkeys + both device ids + `tx_uuid`)
  MUST be bound into the HKDF `info`. Anonymous ECDH is forbidden, including as
  an error fallback — fail closed. Spec §3.3; `ADV-07` is the test.
  STATUS: the session layer itself (`packages/shared/src/crypto/session.ts` --
  `deriveSessionKey`, `sealSessionMessage`/`openSessionMessage`) is BUILT,
  transport-agnostic, ahead of the GATT transport it will eventually run over.
  `GET /devices/:deviceId/credential` (server) and `fetchPeerCredential`
  (mobile) provide the server-signed peer identity lookup this needs. `ADV-07`
  is AUTOMATED against this layer directly, no radio or GATT transport
  required (`session.test.ts`). NOT yet wired into any UI or transport --
  that's the GATT layer's job when M3 resumes.
- **Foreground-service type** for the connection-holding BLE service
  (Android 14/15). Not built; no foreground service exists yet.

**Mode C (offline IOU)**
- UI shows AMBER PENDING_INTENT only. Never a green checkmark until server
  settlement. This is a hard rule; do not relax it for "better UX."
- The user is shown an explicit trust warning before confirming an offline send.
- The payee's side is bound by the same rule, for a different reason. A
  payee's phone has no way to verify a peer's identity-key signature (only the
  server holds enrolled identity_pubkeys), so a received offline claim is an
  UNVERIFIED ASSERTION, not a cryptographic fact. The Mode C info QR
  (`IncomingIouInfo`) is deliberately unsigned and is never proof of anything.
  A payee may only go green after independently fetching
  `GET /tx/:txUuid/receipt` and verifying that server-signed COSE_Sign1 against
  the pinned server public key — the same check a Mode B payee performs. Never
  derive payee-side green from the payer's own screen, the info QR, or the
  payer's local SETTLED status.
- Local Mode C persistence (`mobile/src/db/offlineIntents.ts`) is plain,
  UNENCRYPTED expo-sqlite. This is a deliberate scope decision that knowingly
  departs from spec §5's "encrypted local SQLite": what's stored is a
  COSE-signed proposal whose security property is integrity (from the
  signature), not confidentiality — the same sensitivity as the M1 QR payload,
  which already travels in the clear. At-rest encryption (SQLCipher, e.g. via
  op-sqlite) is a named follow-up, not an oversight, and is NOT a prerequisite
  for M3. Do not add it opportunistically mid-milestone.
- The client's local `device_seq` counter is NOT a security control. Only the
  server's `devices.last_seq` is authoritative; `ADV-03` is designed to pass
  even if the local counter is freely manipulated.

**Sensor gate**
- R_AB >= 0.80 is a TUNABLE BASELINE, not a constant. Thresholds (accel, gyro,
  mag gradient, RSSI, correlation) live in config, never hardcoded. Per-device or
  per-device-class thresholds are expected, informed by M0 harness data.
- Open question, not yet settled: whether a scalar threshold gate is
  sufficient at all (see M0's status in §4). `telemetry/analysis/bump_model.py`
  documents that a fixed peak-accel threshold calibrated on one session missed
  6 of 13 real bumps in a held-out session, motivating a jerk-feature
  experiment there. "Config over constants" holds either way — a fitted model,
  if one is ever needed, must still express its decision boundary as config,
  never as a binary blob shipped in the APK.

## 6. Platform / tooling constraints
- **No Android Studio.** Toolchain only: JDK 17, Android SDK `cmdline-tools`,
  `platform-tools` (adb), `build-tools`, platform `android-35`. `ANDROID_HOME` set.
- **Native module uses the Expo Modules API** (`expo.modules.tappay.*`). Do NOT
  scaffold raw TurboModule/New-Architecture boilerplate. If you find yourself
  writing TurboModule spec files, you're on the wrong path.
- **Expo Go cannot run this.** BLE, 100Hz sensors, StrongBox, biometrics, and the
  foreground service require a custom dev-client build (installed APK). Expo Go is
  only for pure-UI iteration with no native calls.
- **Android 12+ runtime BLE permissions** are mandatory: `BLUETOOTH_SCAN` (with
  `neverForLocation`), `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`. Declare a
  foreground-service type for the connection-holding service on Android 14/15.
- **Postgres 16 runs in Docker** via docker-compose (pgAdmin optional). Schema
  changes go through versioned migrations. Never hand-run DDL against a live db.
- **Release builds are signed** with a dedicated keystore. Debug-only signing is
  not "production grade."
- **Secrets never ship in the app binary** except the pinned server *public* key
  (`mobile/src/config/serverPublicKey.ts`), used to verify server COSE receipts
  in every mode that checks a receipt — M1's payer check, Mode B's payee, and
  Mode C's payee status check — not just Mode B. It is a public key, not a
  secret. It is hardcoded hex derived from the gitignored
  `server/keys/server_identity.pem`: regenerating that key REQUIRES re-pinning
  this constant and rebuilding the APK, or every on-device receipt verification
  fails with what looks like a crypto bug rather than config drift.

## 7. Definitions
- **200ms target**: elapsed time from bump impact to a successful phone-to-phone
  BLE connection. It is a post-bump connection budget, not an end-to-end
  settlement or including cold BLE discovery.
- **The seam**: `IBankAdapter`. Swapping the mock ledger for a real bank must
  require zero changes above this interface.
- **One-phone testing**: development happens on a single physical Android
  device (Samsung Galaxy S24 Ultra, `SM-S928B`); a second phone is expected
  later but isn't available yet. Every QR scan step therefore ALSO has a manual
  paste fallback (`mobile/src/components/qrFlow.tsx`), and identity keys use
  per-device KeyStore aliases so two roles can be enrolled on one handset
  (`KeyStoreManager.kt`). These are not debug leftovers — they are currently the
  only way to exercise a two-party protocol. Do not remove them. Anything
  requiring genuinely simultaneous two-device behavior (BLE, bump correlation,
  `ADV-04`/`ADV-05`) is blocked on the second phone, not on missing code —
  `ADV-07` is the exception: it's a protocol-level test and needs no radio.

## 8. Conventions
- Server: Node.js + Fastify + TypeScript. Prefer explicit types on all money and
  crypto boundaries.
- Config over constants for every tunable (thresholds, TTLs, latency injection).
- Errors are typed and surfaced, never swallowed. Fail closed on any signature,
  balance, or attestation check.
- Import-extension convention: files inside `packages/shared` import each other
  with a literal `.js` extension on `.ts` source files (e.g.
  `export * from "./types.js"`). This is REQUIRED for Node/tsx ESM resolution
  under that package's `"type": "module"`. Do not "correct" these to
  extensionless or `.ts` — it breaks the server build.
- `mobile/metro.config.js` carries three load-bearing workarounds for that
  convention plus the pnpm workspace: `watchFolders` at the repo root,
  `unstable_enableSymlinks`, and a custom `resolveRequest` that retries a failed
  relative `.js` import as `.ts`. None of it is cruft — removing any piece
  breaks the mobile Metro bundle with a misleading "module not found" pointing
  at the wrong file.
- Keep this CLAUDE.md current, in the same change that makes it stale:
  - build/test/lint/setup commands change → update §9.
  - a milestone's status or exit-gate reality changes → update §4.
  - an invariant in §5 becomes real, becomes untrue, or gains a documented
    exception → update §5. Never leave §5 asserting something the code doesn't
    do — move it to the "code that does not exist yet" block instead.
  - a new top-level directory or workspace package appears → update §3.
  If a section here contradicts the code, the code is the evidence: fix the
  document, and say in the commit message that you did.

## 9. Commands
```bash
# Infra (everyday)
docker compose up -d db telemetry   # postgres 16 on host :5433 (not 5432); harness on :8080
docker compose up -d pgadmin        # optional, :5050
# NOTE: docker-compose.yml previously declared a `server` service under an
# `integration` profile with no server/Dockerfile -- removed as unbuildable.
# The server always runs on the host (pnpm --filter server dev), not in Docker.

# Server -- first-run bootstrap (required once; every server script is
# `dotenv -e ../.env`, and the identity key is read at module load time, so
# `dev`/`test`/`migrate` all fail before any code runs without these two steps)
cp .env.example .env
pnpm --filter server generate-server-key   # writes server/keys/server_identity.pem (gitignored)
# ^ if you ever regenerate this key, you MUST re-pin SERVER_PUBLIC_KEY_HEX in
#   mobile/src/config/serverPublicKey.ts and rebuild the APK -- see §6.

# Server -- everyday
pnpm --filter server migrate     # node-pg-migrate up
pnpm --filter server seed        # demo balances via mint-account transfers (idempotent)
pnpm --filter server dev
pnpm --filter server test        # requires db up + migrations applied

# Shared crypto/wire package (packages/shared -- the largest test surface)
pnpm --filter @tappay/shared test   # note the scope: `--filter shared` does not resolve
pnpm --filter @tappay/shared lint   # tsc --noEmit

# Everything CI runs, in one shot
pnpm -r lint && pnpm --filter server migrate && pnpm -r test

# Mobile (dev-client build to a plugged-in phone)
npx expo run:android             # builds + installs dev client APK
adb reverse tcp:3000 tcp:3000    # SERVER_BASE_URL is http://localhost:3000
adb reverse tcp:8080 tcp:8080    # telemetry harness, if using it from the app
pnpm --filter @tappay/mobile lint

# Telemetry harness (Docker only -- no host-Python entrypoint by design)
docker compose up -d telemetry   # dashboard on :8080, phones stream over WebSocket
# analysis scripts take a session .jsonl path (data/ is bind-mounted into the container):
docker compose exec telemetry python -m analysis.compute_correlation data/1.jsonl
docker compose exec telemetry python -m analysis.bump_separability data/1.jsonl
docker compose exec telemetry python -m analysis.bump_model data/1.jsonl data/2.jsonl data/4.jsonl
```

## 10. Testing
- Adversarial suite is part of "done" (spec §10). Current status:
  - ADV-01 replay — AUTOMATED (`server/src/routes/__tests__/tx.test.ts`). Note:
    the spec's expected outcome says "rejected", but the correct behavior is
    IDEMPOTENT REPLAY — an identical resubmission returns the exact same
    receipt bytes with no second journal write. §5's idempotency invariant
    wins over the spec's wording; do not "fix" this toward rejection.
  - ADV-02 amount tamper — AUTOMATED (`tx.test.ts`).
  - ADV-03 rollback spend — AUTOMATED (`server/src/routes/__tests__/sync.test.ts`).
  - ADV-06 deadlock stress (100 concurrent bidirectional transfers) —
    AUTOMATED (`server/src/adapters/__tests__/MockBankAdapter.test.ts`).
  - ADV-04 table-drop rejection — BLOCKED on M3's motion engine + a physical device.
  - ADV-05 ambiguous bump — BLOCKED on M3 + a second physical phone.
  - ADV-07 MITM relay — AUTOMATED (`packages/shared/src/crypto/__tests__/session.test.ts`)
    against the authenticated ECDH session layer (§5) directly; needed no radio
    and no second phone, contrary to this file's own earlier assumption.
- Crypto paths are tested against published third-party vectors (COSE-WG +
  Wycheproof — see §5's crypto invariants) before integration.
- Run `/security-review` on any change touching signing, ECDH, the SQL locking
  code, the sync/reconciliation path, or any route that keys durable state on a
  client-chosen identifier (`tx_uuid`, `device_id`, a nonce) before considering
  it complete — that last category is where M2's one real found vulnerability
  actually lived, not in signing or locking.

## 11. Out of scope for MVP
iOS build and Swift native module; real payment rails / real funds; multi-currency;
production banking compliance (PCI DSS, EMVCo). Design must not preclude these,
but do not implement them now.