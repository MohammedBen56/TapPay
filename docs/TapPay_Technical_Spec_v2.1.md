# TapPay — Technical Specification v2.1

**Status:** Approved for implementation
**Supersedes:** v2.0
**Currency:** MAD, integer minor units (centimes) as `bigint`. Floating point for money is forbidden anywhere in the stack.

---

## Changelog: v2.0 to v2.1

These are the decisions made after the v2.0 review. They are binding.

1. **Authenticated ECDH.** The session key exchange is no longer anonymous. Ephemeral P-256 public keys are signed by the hardware StrongBox identity key. Unauthenticated ECDH is a MITM hole and is removed.
2. **Nonce inside the signed payload.** The receiver nonce, `tx_uuid`, and timestamp live *inside* the COSE_Sign1 signed structure, not alongside it. Replay defense is cryptographic, not procedural.
3. **Reservation-expiry sweeper.** A background job releases expired `HELD` reservations. Added to Milestone 1 scope.
4. **Server-side attestation verification.** Device attestation certificate chains are verified at enrollment against Google roots. Added to Milestone 1 scope.
5. **Correlation threshold is a tunable baseline.** `R_AB >= 0.80` is a starting point, not a constant. Thresholds live in config and are expected to become per-device-class, informed by Milestone 0 harness data.
6. **iOS is out of MVP scope but architecturally compatible.** No NFC/HCE dependency exists, so iOS is proven-possible. Not built in the MVP.
7. **Infrastructure split.** Postgres, pgAdmin, telemetry, and the server run in Docker. The Android build toolchain runs on the host (USB/adb device access).
8. **pnpm workspace monorepo.** One lockfile, one lint/test surface across four packages.
9. **Incremental git.** Small branches, a PR per exit-criterion-sized unit. No end-of-project megadiff.
10. **Expo Modules API, not TurboModules.** The native module uses the Expo Modules API. Raw New-Architecture TurboModule scaffolding is not used.
11. **200ms target redefined.** It is the budget from bump impact to a successful phone-to-phone BLE connection. It is a post-bump connection budget, not end-to-end settlement and not including cold discovery.
12. **Risk-first build order.** The unproven physical assumption (bump correlation) is validated first, before any downstream layer is built.

---

## 1. Overview and scope

TapPay is a peer-to-peer proximity payment app. Two phones are physically bumped; a fused multi-sensor signal (BLE RSSI + magnetometer + accelerometer + gyroscope) binds the physical tap to a cryptographically signed transaction carried over a local BLE GATT channel. The backend is a mock neobank with a double-entry ledger. It moves no real money and must never be connected to real funds without a banking license (Bank Al-Maghrib).

**In scope (MVP):** Android app, mock neobank server, three connectivity modes, sensor-fusion intent binding, telemetry harness.

**Out of scope (MVP):** iOS build and Swift native module; real payment rails; multi-currency; production banking compliance (PCI DSS, EMVCo). The design must not preclude these.

Three nodes: Payer device, Payee device, Mock Neobank server.

```
        LAPTOP (dev / infra, Docker)
  ┌───────────────────────┬───────────────────────┐
  │  Telemetry harness    │   Postgres 16 + pgAdmin│
  │  (Python/FastAPI)     │   (ledger + holds)     │
  └──────────▲────────────┴───────────▲────────────┘
   WebSocket │ (debug builds)   REST   │ (HTTPS/CBOR)
  ┌──────────┴───────────┐    ┌────────┴────────────┐
  │  PHONE A (Payer)     │◄──►│  PHONE B (Payee)     │
  │  RN app + Kotlin     │BLE │  RN app + Kotlin     │
  │  (KeyStore/IMU/Mag/  │GATT│  (KeyStore/IMU/Mag/  │
  │   BLE)               │    │   BLE)               │
  └──────────────────────┘    └──────────────────────┘
```

Transaction lifecycle (Mode A, happy path): open tap screen on both → BLE scan + advertise → pre-arm on RSSI/mag convergence → bump impact detected → BUMP_CLAIM exchange → cross-correlation qualifies the pair → authenticated ECDH derives an AES-256-GCM session key → payer biometric-signs a COSE_Sign1 proposal (with fresh receiver nonce inside) → payee submits to `/tx/submit` → server verifies signature, reserves hold, writes journal, returns signed receipt → receipt relayed to payer → both show SETTLED.

---

## 2. Layer 1: Mock neobank backend

Node.js + Fastify + TypeScript. All bank behavior sits behind one interface so a real bank could replace the mock with zero changes above the seam.

### 2.1 The seam (`IBankAdapter`)

```typescript
export interface ReservationResult {
  success: boolean;
  reservationId?: string;
  failureReason?: string;
}

export interface CommitResult {
  success: boolean;
  settledAt: Date;
  receiptSignature: Uint8Array; // COSE_Sign1 from server identity key
  failureReason?: string;
}

export interface IBankAdapter {
  getAvailableBalance(accountId: string, currency: string): Promise<bigint>;
  reserve(txUuid: string, accountId: string, amount: bigint, currency: string, ttlSeconds: number): Promise<ReservationResult>;
  commit(txUuid: string): Promise<CommitResult>;
  release(txUuid: string): Promise<void>;
  transfer(txUuid: string, fromAccountId: string, toAccountId: string, amount: bigint, currency: string): Promise<CommitResult>;
}
```

`MockBankAdapter` injects artificial latency (200–800ms) and configurable fault injection for adversarial testing.

### 2.2 PostgreSQL schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- User accounts
CREATE TABLE accounts (
    account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL UNIQUE,
    email      TEXT NOT NULL UNIQUE,
    currency   CHAR(3) NOT NULL DEFAULT 'MAD',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Device identity + attestation registry
CREATE TABLE devices (
    device_id        BYTEA PRIMARY KEY,          -- 16-byte UUID
    user_id          UUID NOT NULL REFERENCES accounts(user_id),
    identity_pubkey  BYTEA NOT NULL,             -- 33-byte compressed P-256
    platform         TEXT NOT NULL CHECK (platform IN ('android','ios')),
    attestation_blob JSONB NOT NULL,             -- verified at enrollment, see 2.4
    attestation_ok   BOOLEAN NOT NULL DEFAULT false,
    last_seq         BIGINT NOT NULL DEFAULT 0,  -- anti-rollback monotonic tracker
    enrolled_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Double-entry journal (immutable source of truth)
CREATE TABLE journal (
    id         BIGSERIAL PRIMARY KEY,
    tx_uuid    UUID NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount     BIGINT NOT NULL,                  -- signed minor units (+credit, -debit)
    currency   CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_tx_account UNIQUE (tx_uuid, account_id)
);
CREATE INDEX idx_journal_account_created ON journal(account_id, created_at);

-- Balance holds / reservations
CREATE TABLE reservations (
    tx_uuid    UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount     BIGINT NOT NULL CHECK (amount > 0),
    expires_at TIMESTAMPTZ NOT NULL,
    state      TEXT NOT NULL CHECK (state IN ('HELD','COMMITTED','RELEASED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reservations_expiry ON reservations(expires_at) WHERE state = 'HELD';

-- Offline IOU intent ledger (Mode C reconciliation)
CREATE TABLE offline_intents (
    tx_uuid       UUID PRIMARY KEY,
    sender_id     UUID NOT NULL REFERENCES accounts(user_id),
    receiver_id   UUID NOT NULL REFERENCES accounts(user_id),
    amount        BIGINT NOT NULL,
    currency      CHAR(3) NOT NULL,
    cose_proposal BYTEA NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('PENDING','SETTLED','FAILED_INSUFFICIENT','FAILED_EXPIRED')),
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.3 Ledger invariants

- **Sum rule.** For every `tx_uuid`, the sum of `journal.amount` rows is exactly zero.
- **Lexicographical lock ordering.** When transferring between two accounts, acquire `SELECT ... FOR UPDATE` row locks in strict lexicographical UUID order. This prevents deadlock under concurrent bidirectional transfers.
- **Idempotency.** Re-submitting the same `tx_uuid` is a no-op that returns the existing signed COSE_Sign1 receipt.
- **Integer money only.** No floats or float-backed decimals anywhere.

### 2.4 Reservation sweeper (new in v2.1)

A background worker runs on an interval and releases stale holds:

```sql
UPDATE reservations
SET state = 'RELEASED'
WHERE state = 'HELD' AND expires_at < now();
```

Without this, available balance leaks to abandoned taps. The sweep must be idempotent and safe to run concurrently with commits (a `COMMITTED` row is never touched).

### 2.5 Attestation verification (new in v2.1)

At enrollment the server verifies the device attestation certificate chain (Android Key Attestation) up to a Google root before setting `attestation_ok = true`. An unverified `attestation_blob` is stored but never trusted. Enrollment fails closed if the chain does not validate.

---

## 3. Layer 2: Mobile client

React Native (Expo, current stable SDK). UI and application-layer crypto in TypeScript; hardware radios, sensors, and the keychain in a **custom Expo Modules API** native module (Kotlin).

### 3.1 Structure

```
mobile/
├── modules/tappay-native/
│   └── android/src/main/java/expo/modules/tappay/
│       ├── TapPayNativeModule.kt      # Expo module bridge
│       ├── security/KeyStoreManager.kt # StrongBox/TEE P-256, ECDH signing
│       ├── sensors/MotionEngine.kt     # 100Hz ring buffer, accel/gyro cross-corr
│       ├── sensors/MagEngine.kt        # magnetometer gradient profiler
│       └── ble/{BleGattServer,BleScanner}.kt
├── src/
│   ├── components/    # UI (checkmark, amber banner, biometric prompt)
│   ├── crypto/        # COSE_Sign1 / CBOR / P-256 ECDH (authenticated)
│   ├── db/            # encrypted local SQLite (offline intents)
│   ├── ledger/        # MockBank client, IBankAdapter seam mirror
│   ├── screens/       # TapScreen, HistoryScreen, DevSettings
│   └── transport/     # BLE GATT + QR fallback
└── App.tsx
```

> Note: this project cannot run in Expo Go. BLE, 100Hz sensors, StrongBox, biometrics, and the foreground service all require a custom **dev-client** build (installed APK).

### 3.2 Hardware identity keys (`KeyStoreManager.kt`)

Hardware-backed NIST P-256 signing key, biometric-gated, StrongBox with TEE fallback:

```kotlin
val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
val builder = KeyGenParameterSpec.Builder("tappay_identity",
        KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
    .setDigests(KeyProperties.DIGEST_SHA256)
    .setUserAuthenticationRequired(true)
    .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    .setAttestationChallenge(serverNonce)
try {
    builder.setIsStrongBoxBacked(true)
    kpg.initialize(builder.build()); kpg.generateKeyPair()
} catch (e: StrongBoxUnavailableException) {
    builder.setIsStrongBoxBacked(false) // fall back to TEE
    kpg.initialize(builder.build()); kpg.generateKeyPair()
}
```

### 3.3 Authenticated session key exchange (changed in v2.1)

1. A and B each generate an ephemeral P-256 key pair for this session.
2. Each side **signs its ephemeral public key** with its StrongBox identity key.
3. Each side verifies the peer's signature against the peer's registered `identity_pubkey` before deriving the shared secret. Reject on failure.
4. Derive the AES-256-GCM session key from the ECDH shared secret via HKDF, binding the transcript (both ephemeral pubkeys + both identities + `tx_uuid`) into the HKDF `info`.

This binds the channel to the two specific enrolled devices and closes the relay/MITM path. Do not fall back to anonymous ECDH under any error condition; fail closed.

---

## 4. Layer 3: Multi-sensor proximity and intent protocol

### 4.1 Arming state machine

```
IDLE / SCANNING
  low-power BLE discovery; IMU ring buffer at 10 Hz
        │  arm when either holds:
        │   d(RSSI)/dt > +15 dBm/s   OR   ||dB/dt|| > 35 uT/s
        ▼
ARMED
  high-duty GATT open; IMU to 100 Hz; gyro recoil tracking
  timeout 3.0s back to IDLE if no bump
        │  trigger when: ||a|| > 2.5 g
        ▼
TRIGGERED
  lock 100 ms IMU window (10 samples); send BUMP_CLAIM over GATT
```

All numeric thresholds here are **config values seeded from Milestone 0 data**, not hardcoded constants.

### 4.2 Signal processing

Sample accelerometer `a` and gyroscope `w` at 100 Hz. High-pass the accelerometer (alpha 0.8) to strip the 1 g gravity baseline:

```
a_filtered[n] = alpha * (a_filtered[n-1] + a_raw[n] - a_raw[n-1])
```

Reduce 6-DOF motion to two rotation-invariant scalar magnitude profiles over the 100 ms peak window (50 ms either side of t_peak):

```
A[n] = || a_filtered[n] ||     (10 samples)
W[n] = || w[n] ||              (10 samples)
```

Normalized cross-correlation across the combined linear and rotational profiles between A and B, over a small lag search k:

```
R_AB[k] = ( sum A_A[n]*A_B[n+k] + sum W_A[n]*W_B[n+k] )
          / sqrt( (sum A_A^2 + sum W_A^2) * (sum A_B^2 + sum W_B^2) )
```

### 4.3 Qualification gate

A tap is valid iff all conditions hold simultaneously. Every bound is tunable:

- `RSSI >= -70 dBm`
- `|t_peak_A_corrected - t_peak_B| < 100 ms`
- relative accel-peak difference `<= 0.40`
- `max(W_A) >= 1.5 rad/s AND max(W_B) >= 1.5 rad/s`
- `max_k R_AB[k] >= 0.80` (baseline; expected to be per-device-class)

If more than one candidate device qualifies, halt into `AMBIGUOUS` and prompt for re-tap.

### 4.4 GATT clock synchronization

NTP-style exchange over GATT, no central time server:

```
A -> PING {t0}
B receives t1, replies PONG {t0,t1,t2} at t2
A receives t3
RTT   = (t3 - t0) - (t2 - t1)
theta = ((t1 - t0) + (t2 - t3)) / 2
```

Run 5 exchanges, keep only the single minimum-RTT sample (~10–15 ms), apply `theta` to normalize B's timestamps.

---

## 5. Layer 4: Connectivity and reconciliation

```typescript
export enum ConnectivityMode {
  MODE_A = 'RECEIVER_ONLINE', // canonical, zero risk
  MODE_B = 'SENDER_ONLINE',   // bridge, server-signed receipt
  MODE_C = 'BOTH_OFFLINE',    // signed IOU promise
}
export function evaluateConnectivity(receiverOnline: boolean, senderOnline: boolean): ConnectivityMode {
  if (receiverOnline) return ConnectivityMode.MODE_A;
  if (senderOnline)   return ConnectivityMode.MODE_B;
  return ConnectivityMode.MODE_C;
}
```

**Mode A (receiver online).** Payer signs COSE_Sign1 proposal (fresh receiver nonce + tx_uuid + ts inside the signature). Payee submits to `/tx/submit`. Server verifies, reserves, journals, returns signed receipt. Payee relays receipt over GATT. Both show green SETTLED.

**Mode B (sender online, bridge).** Payer receives the payee's nonce over GATT, submits directly to `/tx/submit` over cellular, relays the server-signed receipt back over GATT. Payee verifies against the pinned server public key baked into the app binary. Both show green SETTLED.

**Mode C (both offline, signed IOU).** Not a transfer, a promise. The payee bears counterparty risk and is warned explicitly before confirming. This has been settled and is intentional.
- Precondition: payer holds a `freshness_token` issued within 24h.
- Payer signs COSE_Sign1 `{amount, recipient_id, tx_uuid, seq, ts}` with the hardware identity key.
- Both devices persist the proposal to encrypted local SQLite.
- **UI is strictly amber `PENDING_INTENT`. Never a green checkmark until server settlement.** Hard rule.
- On reconnect, `/tx/sync` processes intents in sequence. Sufficient balance to `SETTLED`; insufficient to `FAILED_INSUFFICIENT` and the sender device is flagged for monotonic sequence regression.

---

## 6. Layer 5: Telemetry and calibration harness (Docker)

A Python FastAPI WebSocket server ingests real-time sensor streams from dev builds and renders waveforms (accel magnitude, gyro recoil, mag gradient, RSSI) on an HTML5 dashboard. It runs in a container; phones stream to it over the LAN on port 8080. It is a dev tool and never ships. Its purpose is to replace guessed thresholds with measured ones, and it is the primary instrument for Milestone 0.

---

## 7. Security model summary (invariants)

Fail closed on any signature, balance, or attestation check.

- Identity keys hardware-backed P-256, biometric-gated.
- ECDH authenticated by identity-key signatures over ephemeral pubkeys; transcript bound into HKDF.
- Receiver nonce, tx_uuid, timestamp inside the COSE_Sign1 payload.
- COSE/CBOR verified against NIST test vectors before any transaction path is trusted.
- Attestation chains verified server-side at enrollment.
- Ledger sum-to-zero, lexicographical locking, idempotent tx_uuid, integer money.
- Expired holds swept.
- Mode C is deferred-risk with explicit user warning; amber-only UI.

---

## 8. Infrastructure and tooling

- **Docker (compose):** Postgres 16, pgAdmin, telemetry (Python), server (Node) for integration/deploy. Server also runnable on host for the dev inner loop.
- **Host (not Docker):** Android build toolchain (JDK 17, Android SDK, Expo native build) because of USB/adb device access.
- **Monorepo:** pnpm workspace. One lockfile; unified lint/test.
- **DB migrations:** versioned, never hand-run DDL against a live database.
- **Release builds:** signed with a dedicated keystore.
- **No Android Studio.** CLI toolchain only.

---

## 9. Build order (risk-first, do not deviate)

- **M0 — Telemetry harness + bump-correlation spike.** Build the harness, stream both phones, bump ~200 times across grips/orientations/contact points, measure the real `R_AB` distribution. Exit: empirical data and a chosen threshold policy. If correlation is unreliable, stop and revisit intent binding before building anything downstream.
- **M1 — Server ledger + crypto foundation.** Schema, Fastify server, `IBankAdapter`/`MockBankAdapter`, hardware key generation, COSE_Sign1 signing, reservation sweeper, attestation verification, QR fallback transport. Exit: end-to-end payment over QR with real signatures and correct journal writes.
- **M2 — Offline modes + reconciliation.** Mode B, Mode C, `/tx/sync`, sequence-regression detection, amber UI. Exit: airplane-mode tap creates a local IOU; reconnect settles it with no UI falsehood.
- **M3 — Motion engine + BLE GATT transport.** Kotlin MotionEngine (100Hz ring buffer, spike detect, cross-corr), MagEngine, low-latency GATT, RSSI convergence filter, GATT clock sync. Exit: bumping two foregrounded Android phones binds intent and settles over BLE within the post-bump connection budget.

---

## 10. Adversarial test suite (part of "done")

| ID | Category | Procedure | Expected |
|----|----------|-----------|----------|
| ADV-01 | Replay | Intercept a valid COSE_Sign1 proposal, resubmit 5s later | Rejected: stale/replayed nonce (nonce is inside the signature) |
| ADV-02 | Amount tamper | Modify amount byte in serialized CBOR after signing | Signature verification fails; aborted |
| ADV-03 | Rollback spend | Snapshot local SQLite, do a Mode C spend, restore snapshot, spend again | Sequence regression detected on sync; device flagged |
| ADV-04 | Table drop | Drop phone onto a table from ~10 cm | Accel spike fires but low gyro recoil rejects it |
| ADV-05 | Ambiguous bump | Force two candidates with matching peak timestamps | Candidate count > 1 enters AMBIGUOUS; re-tap |
| ADV-06 | Deadlock stress | 100 concurrent bidirectional transfers, 10 worker threads | All succeed, no deadlocks (lexicographical locking) |
| ADV-07 | MITM relay (new) | Relay attacker between A and B during ECDH | Rejected: ephemeral key signature does not match enrolled identity |

Run `/security-review` on any change touching signing, ECDH, the SQL locking code, or sync/reconciliation before it is considered complete.
