# Parked: P2P proximity-payment routes

Everything under `server/src/parked/` is real, working, security-reviewed
code from TapPay's original BLE/bump proximity-payment milestones (M1–M3,
see the root `CLAUDE.md` §4). It is **not dead code** — it's unregistered by
default while the v2 pivot ships a plain Bearer-authenticated neobank MVP
first (see `docs/TapPay_v2_Technical_Design.md`). It comes back when
BLE-triggered proximity payments resume.

## What's here

- `attestation/` — Android hardware Key Attestation cert-chain verification
  (`verify.ts`), the enrollment-nonce store (`nonceStore.ts`), and the pinned
  Google root certs.
- `routes/devices.ts` — device enrollment against an attestation chain,
  device credential issuance, freshness tokens.
- `routes/sync.ts` — `/tx/sync`, Mode C offline-IOU batch reconciliation.
- `routes/deviceLookup.ts` — `device_id` → `(device, account)` lookup, shared
  by `devices.ts`, `sync.ts`, and `tx-cose.ts`.
- `routes/tx-cose.ts` — `POST /tx/submit`, the COSE_Sign1-verified P2P
  transfer path. Split out of the original `routes/tx.ts`, which now only
  keeps the two generic GET routes live.

Every `__tests__` directory moved alongside its code, so the full suite
(attestation verification, synthetic attestation-chain generation, device
enrollment, offline sync, `/tx/submit`'s adversarial cases — ADV-01/01b/02,
self-payment, freshness, currency/amount limits) still runs; it's just gated
behind an explicit opt-in rather than the default `buildApp()` call.

## How it's gated

`config.enableProximityRoutes` (env `ENABLE_PROXIMITY_ROUTES`, default
**false**). `buildApp({ proximityRoutes: true })` overrides it per call —
every test file under `parked/` uses this explicitly rather than relying on
the env default, so the suite is self-contained regardless of how the server
process itself is configured.

To run the server with these routes live (e.g. to resume M3 work):

```bash
ENABLE_PROXIMITY_ROUTES=true pnpm --filter server dev
```

## Why moved, not deleted, not merely left unrouted

`POST /tx/submit` was unauthenticated by design under the old identity model
(COSE signature verification *was* the auth). Once the product has real
customer accounts and passwords sharing the same server process, an
unauthenticated transfer-signing route sitting in the same route table is a
real hole, not a style issue — moving it here and requiring an explicit flag
makes "is this reachable in production" a one-line, auditable answer instead
of "check whether app.ts happens to still call `registerDeviceRoutes`."
