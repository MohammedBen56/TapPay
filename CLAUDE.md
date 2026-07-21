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
├── docker-compose.yml         # postgres 16 (+ optional pgadmin)
├── server/                    # Node.js/Fastify mock neobank + ledger + REST API
├── mobile/                    # React Native (Expo) app
│   ├── src/                   # TS: UI, crypto (COSE/CBOR/ECDH), ledger client, transport
│   └── modules/tappay-native/ # Expo Modules API native code (Kotlin)
├── telemetry/                 # Python FastAPI + Chart.js sensor calibration harness
└── CLAUDE.md
```

## 4. Build order (RISK-FIRST — do not deviate)
The riskiest assumption is scheduled first on purpose. Do not scaffold the whole
monorepo up front. Gate each milestone on its exit criterion before proceeding.

- **M0 — Telemetry harness + bump-correlation spike.**
  Build `telemetry/` first. Stream both phones' raw IMU/mag/RSSI to the dashboard.
  Bump the two phones ~200 times across varied grips, orientations, contact points.
  Measure the actual R_AB distribution.
  Exit: we have empirical R_AB data and a chosen per-device-class threshold policy.
  If correlation is unreliable, STOP and revisit the intent-binding design before
  building anything downstream.

- **M1 — Server ledger + crypto foundation.**
  Postgres double-entry schema, Fastify server, `IBankAdapter` + `MockBankAdapter`
  (artificial 200–800ms latency + fault injection). Hardware-backed key generation
  (Kotlin `KeyStoreManager`), COSE_Sign1/CBOR signing (TS). Reservation-expiry
  sweeper. Server-side attestation cert-chain verification at enrollment.
  QR-code fallback transport.
  Exit: two devices complete an end-to-end payment over QR scan with real
  signatures and correct journal writes.

- **M2 — Offline modes + reconciliation.**
  Mode B (server-signed receipt relay) and Mode C (signed IOU persistence),
  `/tx/sync`, sequence-regression detection, amber PENDING_INTENT UI.
  Exit: airplane-mode tap creates a local IOU; reconnect settles it on the ledger
  with no UI falsehood.

- **M3 — Motion engine + BLE GATT transport.**
  Kotlin `MotionEngine` (100Hz ring buffer, spike detect, 2-channel cross-corr),
  `MagEngine`, low-latency GATT server/scanner, RSSI convergence filter, GATT
  clock sync.
  Exit: bumping two foregrounded Android phones binds intent and settles over BLE
  within the 200ms target.

## 5. Non-negotiable invariants
Claude Code must never generate code that violates these. If a task appears to
require breaking one, stop and flag it.

**Ledger**
- Every `tx_uuid`'s journal rows sum to exactly zero.
- Acquire row locks (`SELECT ... FOR UPDATE`) in strict lexicographical UUID order.
- Re-submitting the same `tx_uuid` is a no-op that returns the existing signed
  receipt (idempotent).
- Money is bigint minor units. No floats, no decimals-as-float.
- Expired `HELD` reservations must be released by the sweeper. Balance must never
  leak to abandoned holds.

**Crypto**
- Identity signing keys are hardware-backed P-256 (StrongBox, TEE fallback),
  biometric-gated (`setUserAuthenticationRequired(true)`).
- The session ECDH is authenticated: ephemeral public keys MUST be signed by the
  StrongBox identity key. Unauthenticated ECDH is forbidden (MITM hole).
- The receiver nonce, `tx_uuid`, and timestamp MUST live inside the COSE_Sign1
  signed payload, not alongside it. Replay defense is cryptographic, not
  procedural.
- Verify COSE/CBOR against published NIST test vectors before trusting any
  transaction path.
- Device attestation cert chains are verified server-side at enrollment against
  Google roots. Never store an unverified attestation blob as trusted.

**Mode C (offline IOU)**
- UI shows AMBER PENDING_INTENT only. Never a green checkmark until server
  settlement. This is a hard rule; do not relax it for "better UX."
- The user is shown an explicit trust warning before confirming an offline send.

**Sensor gate**
- R_AB >= 0.80 is a TUNABLE BASELINE, not a constant. Thresholds (accel, gyro,
  mag gradient, RSSI, correlation) live in config, never hardcoded. Per-device or
  per-device-class thresholds are expected, informed by M0 harness data.

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
- **Secrets never ship in the app binary** except the pinned server public key
  (used to verify server COSE receipts in Mode B).

## 7. Definitions
- **200ms target**: elapsed time from bump impact to a successful phone-to-phone
  BLE connection. It is a post-bump connection budget, not an end-to-end
  settlement or including cold BLE discovery.
- **The seam**: `IBankAdapter`. Swapping the mock ledger for a real bank must
  require zero changes above this interface.

## 8. Conventions
- Server: Node.js + Fastify + TypeScript. Prefer explicit types on all money and
  crypto boundaries.
- Config over constants for every tunable (thresholds, TTLs, latency injection).
- Errors are typed and surfaced, never swallowed. Fail closed on any signature,
  balance, or attestation check.
- Keep this CLAUDE.md current: when build/test/lint commands change, update
  Section 9 in the same change.

## 9. Commands (reconcile with actual scaffold after /init)
```bash
# Database
docker compose up -d db          # postgres 16
docker compose up -d pgadmin     # optional

# Server
pnpm --filter server migrate
pnpm --filter server dev
pnpm --filter server test

# Mobile (dev-client build to a plugged-in phone)
npx expo run:android             # builds + installs dev client APK
pnpm --filter mobile lint
pnpm --filter mobile test

# Telemetry harness
python telemetry/server.py       # dashboard on :8080, phones stream over WebSocket
```

## 10. Testing
- Adversarial suite is part of "done": ADV-01 replay, ADV-02 amount tamper,
  ADV-03 rollback spend, ADV-04 table-drop rejection, ADV-05 ambiguous bump,
  ADV-06 deadlock stress (100 concurrent bidirectional transfers).
- Crypto paths tested against NIST vectors before integration.
- Run `/security-review` on any change touching signing, ECDH, the SQL locking
  code, or the sync/reconciliation path before considering it complete.

## 11. Out of scope for MVP
iOS build and Swift native module; real payment rails / real funds; multi-currency;
production banking compliance (PCI DSS, EMVCo). Design must not preclude these,
but do not implement them now.