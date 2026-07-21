# TapPay — Build Guide (install to done)

This is the runbook. Follow it top to bottom. It assumes the v2.1 spec is the source of truth and that you will drive most of the coding through Claude Code.

**You already have:** VS Code, Node, npm, Docker, Claude Code.
**You will install on the host:** pnpm, JDK 17, Android SDK command-line tools. Everything else (Postgres, pgAdmin, telemetry, server-for-integration) runs in Docker.

You can let Claude Code run the install commands, but it needs to know your OS and you should watch the toolchain installs. The commands are below so you can supervise or run them yourself.

---

## Phase 0 — Host prerequisites

### 0.1 Verify what you have

```bash
node -v        # expect >= 20
npm -v
docker version
docker compose version
code -v
claude --version
```

### 0.2 pnpm (OS-agnostic)

Corepack ships with Node. Prefer it:

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm -v
```

If corepack is unavailable: `npm install -g pnpm`.

### 0.3 JDK 17 (OS-specific)

Modern Android Gradle Plugin needs JDK 17. Not 21, not 11.

**macOS:**
```bash
brew install --cask temurin@17
```

**Windows:**
```powershell
winget install EclipseAdoptium.Temurin.17.JDK
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt update && sudo apt install -y openjdk-17-jdk
```

Verify: `java -version` shows 17.

### 0.4 Android SDK command-line tools (no Android Studio)

You need `cmdline-tools`, `platform-tools` (adb), `build-tools`, and a platform.

**macOS (simplest):**
```bash
brew install --cask android-commandlinetools
```

**Windows / Linux:** download "Command line tools only" from the Android developer site, unzip into `<ANDROID_HOME>/cmdline-tools/latest/` (the `latest` folder name matters).

Set environment variables (add to your shell profile, or Windows System Environment Variables):

```bash
# macOS/Linux example
export ANDROID_HOME="$HOME/Library/Android/sdk"    # or wherever you placed it
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"
```

Install the SDK pieces and accept licenses (target the current stable API; baseline shown):

```bash
sdkmanager --list
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
sdkmanager --licenses     # accept all
```

Some native dependencies may later require the NDK. Install only if a build asks for it: `sdkmanager "ndk;<version>"`.

### 0.5 Phones

On both phones: enable Developer Options, turn on USB debugging, plug in over USB, accept the authorization prompt.

```bash
adb devices     # both phones must show as "device", not "unauthorized"
```

### 0.6 Phase 0 exit check

```bash
java -version         # 17
adb --version
sdkmanager --list     # shows installed packages
adb devices           # two devices listed
docker compose version
pnpm -v
```

All green means the host is ready. Nothing above installs Python, because the telemetry harness runs in Docker.

---

## Phase 1 — Repository bootstrap

### 1.1 Monorepo skeleton

```
tappay/
├── docker-compose.yml
├── pnpm-workspace.yaml
├── package.json
├── .gitignore
├── .env.example
├── CLAUDE.md                # the file you already have
├── docs/
│   ├── TapPay_Technical_Spec_v2.1.md
│   └── TapPay_Build_Guide.md
├── server/                  # Node/Fastify mock neobank
├── mobile/                  # Expo RN app (+ modules/tappay-native)
└── telemetry/               # Python FastAPI harness (Docker)
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "server"
  - "mobile"
```
(telemetry is Python, outside the pnpm workspace; it lives in the repo and runs via Docker.)

### 1.2 Docker compose (infra + server + telemetry)

`docker-compose.yml` runs Postgres, pgAdmin, and telemetry always. The server has a service you can bring up for integration but leave down while doing host-based server dev.

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: tappay
      POSTGRES_USER: tappay
      POSTGRES_PASSWORD: tappay
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]

  pgadmin:
    image: dpage/pgadmin4
    environment:
      PGADMIN_DEFAULT_EMAIL: dev@tappay.local
      PGADMIN_DEFAULT_PASSWORD: tappay
    ports: ["5050:80"]
    depends_on: [db]

  telemetry:
    build: ./telemetry
    ports: ["8080:8080"]

  server:
    build: ./server
    profiles: ["integration"]   # only starts when explicitly requested
    env_file: .env
    ports: ["3000:3000"]
    depends_on: [db]

volumes:
  pgdata:
```

Everyday dev: `docker compose up -d db pgadmin telemetry`. Server runs on host via `pnpm --filter server dev` against `localhost:5432`. For an integration run: `docker compose --profile integration up -d`.

### 1.3 .gitignore

Cover Node, Expo/RN, Android build output, Python, env, and OS cruft: `node_modules/`, `.expo/`, `android/` build intermediates (`android/app/build/`, `android/.gradle/`), `*.keystore` (except a documented debug one if you choose), `__pycache__/`, `.env`, `.DS_Store`, `dist/`, `build/`.

### 1.4 Git and remote

```bash
cd tappay
git init
git branch -M main
git add .
git commit -m "chore: bootstrap monorepo, docker infra, docs"
# create an empty GitHub repo, then:
git remote add origin <your-repo-url>
git push -u origin main
```

---

## Git and PR workflow (applies to every phase)

You asked for consistent PRs, not a megadiff at the end. The cadence:

- **One branch per exit-criterion-sized unit.** Name by milestone: `m0/telemetry-harness`, `m1/ledger-schema`, `m1/cose-signing`, `m3/gatt-clock-sync`.
- **Small, logical commits** with conventional prefixes: `feat:`, `fix:`, `chore:`, `test:`, `refactor:`, `docs:`. One concern per commit.
- **A PR when a unit is coherent and green**, not when a whole milestone is done. Even solo, open real PRs on GitHub so you get diff review, history, and a CI hook.
- **Before every PR:** run the package's tests and lint. For any PR touching signing, ECDH, SQL locking, or sync, run `/security-review` in Claude Code first.
- **Merge to main only when the unit's tests pass.** Milestone exit criteria are the gates for merging the last PR of that milestone.
- **CI (add during M1):** a GitHub Actions workflow that runs lint + tests for `server` and shared TS on every PR. Keep native Android build out of CI initially (it needs the SDK and is heavy); add it later if you want it. Telemetry gets a lint job.

---

## Claude Code operating procedure

Set up once, then repeat the per-phase loop.

**One-time, first session in the repo:**
- Drop your `CLAUDE.md` at the root, then run `/init`. It reconciles your file against the actual scaffold and fills in real command paths. Refine with `/memory`.
- Add scoped `CLAUDE.md` files inside `server/` and `mobile/modules/tappay-native/` once those exist, so module-specific rules live next to the code.
- `/permissions`: pre-approve safe, routine tools (git status/diff/add/commit, pnpm scripts, gradle reads, file reads). Set `disable-model-invocation: true` on anything with side effects (deploy, destructive db commands) so Claude never runs them on its own judgment.
- Configure MCP with `/mcp` only if a server genuinely helps; you don't need it for the core build.

**Per unit of work (repeat):**
1. `/plan` (or Shift+Tab twice) to enter read-only plan mode. Have Claude map the change before touching files. Approve the plan, then exit to execute.
2. `/goal` to register the current exit-criterion-sized objective; it keeps Claude working toward that outcome across turns with a progress overlay. `/goal clear` when the unit is done.
3. Build. Use `/diff` to review changes before committing. Use `/branch` before anything risky and `/rewind` to undo cleanly.
4. `/security-review` on crypto/ledger/sync changes.
5. Commit in small logical pieces, open the PR.
6. `/clear` between units to start clean; `/compact` within a long unit to reclaim context. Do not drag M1 context into M3.

**Skills, not custom commands.** If you find yourself repeating a workflow (build-and-deploy-to-both-phones, run-COSE-vectors), save it as a skill at `.claude/skills/<name>/SKILL.md`. Custom `/commands` are legacy; skills support the same `/name` invocation and auto-trigger on description match.

**Subagents** (`.claude/agents/`) only where context isolation earns its cost, for example a long native-module task you want to keep out of the main thread. They hide context from the main agent, so use sparingly.

**Do not let Claude Code one-shot the monorepo.** The risk-first order exists because M0's data can reshape M3. Scaffold and build one milestone at a time.

---

## Phase 2 — Milestone 0: telemetry harness + bump-correlation spike

This is first on purpose. It validates the one assumption everything else depends on.

1. Build `telemetry/` (FastAPI WebSocket server + Chart.js dashboard) and its Dockerfile. `docker compose up -d telemetry`, open `http://localhost:8080`.
2. In `mobile/`, create the Expo app with a dev client and a minimal `tappay-native` module that only streams raw accel, gyro, magnetometer, and BLE RSSI over WebSocket to the harness. This is the first real native-module work.
   - `npx expo run:android` builds and installs the dev-client APK to a plugged-in phone. Do this for both phones.
   - Phones and laptop on the same LAN; point the phone stream at the laptop's LAN IP:8080. `adb reverse tcp:8080 tcp:8080` also works per-phone.
3. Bump the two phones ~200 times: vary grip (firm/loose), orientation, and contact point. Watch the waveforms.
4. Compute the `R_AB` distribution offline from the captured streams. Decide the threshold policy: a single baseline, or per-device-class thresholds if the two models diverge (they are different models, so expect some divergence).

**Exit gate:** you have real `R_AB` data and a chosen threshold policy written into config and into `docs/`. If correlation is unreliable across grips, stop and revisit intent binding (loosen the gate, add a second confirmation signal, or lean harder on RSSI + timing) before Phase 3.

PRs here: `m0/telemetry-harness`, `m0/native-sensor-stream`, `m0/correlation-analysis`.

---

## Phase 3 — Milestone 1: server ledger + crypto foundation

1. Server: Fastify + TypeScript, Postgres schema via versioned migrations, `IBankAdapter` + `MockBankAdapter` (200–800ms latency + fault injection).
2. Ledger invariants enforced and tested: sum-to-zero, lexicographical locking, idempotent `tx_uuid`, integer money.
3. Reservation sweeper worker.
4. Attestation verification at enrollment (chain to Google roots; fail closed).
5. Native: `KeyStoreManager.kt` hardware key generation, biometric-gated. TS: COSE_Sign1 signing, CBOR, with the nonce/tx_uuid/timestamp inside the payload. Test the COSE path against NIST vectors before wiring it to transactions.
6. QR fallback transport as the zero-radio path for end-to-end validation.
7. Add CI (server + shared TS lint/test).

**Exit gate:** two phones complete an end-to-end payment over a QR scan with real signatures and correct journal writes. Run ADV-01, ADV-02, ADV-06 here.

PRs: `m1/ledger-schema`, `m1/bank-adapter`, `m1/reservation-sweeper`, `m1/attestation-verify`, `m1/keystore`, `m1/cose-signing`, `m1/qr-transport`, `m1/ci`.

---

## Phase 4 — Milestone 2: offline modes + reconciliation

1. Mode B: sender-online bridge, server-signed receipt relayed over the channel, verified against the pinned server key.
2. Mode C: signed IOU persisted to encrypted local SQLite on both devices; strict amber `PENDING_INTENT` UI; explicit trust warning before an offline send.
3. `/tx/sync` endpoint; sequence-regression detection; freshness token check.

**Exit gate:** airplane-mode tap creates a local IOU; reconnect settles it on the ledger with no UI falsehood. Run ADV-03.

PRs: `m2/mode-b-bridge`, `m2/mode-c-iou`, `m2/tx-sync`, `m2/sequence-regression`.

---

## Phase 5 — Milestone 3: motion engine + BLE GATT transport

1. `MotionEngine.kt`: 100Hz ring buffer, high-pass filter, spike detector, 2-channel cross-correlation, using the thresholds chosen in M0.
2. `MagEngine.kt`: gradient profiler.
3. BLE: low-latency GATT server/scanner, RSSI convergence filter, arming state machine, GATT clock sync (min-RTT of 5 exchanges).
4. Authenticated ECDH over GATT: sign ephemeral keys with the identity key, verify against enrolled identity, HKDF with bound transcript. Run ADV-07.
5. Wire the qualification gate; handle `AMBIGUOUS`.

**Exit gate:** bumping two foregrounded Android phones binds intent and settles over BLE within the post-bump connection budget (bump impact to successful phone-to-phone connection). Run ADV-04, ADV-05, ADV-07.

PRs: `m3/motion-engine`, `m3/mag-engine`, `m3/ble-gatt`, `m3/clock-sync`, `m3/authenticated-ecdh`, `m3/qualification-gate`.

---

## Definition of done

- All four milestone exit gates passed.
- Full adversarial suite ADV-01 through ADV-07 passing.
- COSE/CBOR validated against NIST vectors.
- `/security-review` clean on signing, ECDH, SQL locking, and sync paths.
- Release build signed with a dedicated keystore.
- Git history is a series of small merged PRs, not one dump.
- iOS remains unbuilt and explicitly labeled future work.

---

## Two things to decide before you start

1. **pnpm workspace vs standalone packages.** The guide assumes a workspace (one lockfile, one lint/test surface). If you would rather keep each package fully standalone, tell Claude Code during `/init` and it adjusts the command layout. Workspace is the cleaner production-grade default.
2. **Your OS.** Tell Claude Code which OS you are on before the Phase 0 installs so it runs the right JDK and SDK commands. The rest of the guide is OS-agnostic.
