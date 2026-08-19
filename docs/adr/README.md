# Architecture Decision Records

One file per real decision, in the lightweight MADR shape: Context, Decision,
Alternatives Considered, Consequences, Revisit Trigger. These aren't
retroactive tidying — the reasoning already existed scattered through
CLAUDE.md and git history; this is extraction so a reviewer can find it in
minutes instead of forty.

ADRs are append-only. A changed decision gets a **new** record that
explicitly supersedes an earlier one — see 0005 — never a silent edit to the
old file.

| ADR | Decision |
|---|---|
| [0001](0001-bigint-money.md) | Money is bigint minor units, never float, stack-wide |
| [0002](0002-ordered-row-locks.md) | Explicit ordered `SELECT ... FOR UPDATE`, not `SERIALIZABLE` isolation |
| [0003](0003-opaque-refresh-tokens.md) | Opaque rotating refresh tokens with whole-family revocation on reuse |
| [0004](0004-tx-uuid-not-scoped.md) | `tx_uuid` is client-chosen and therefore not scoped to a caller |
| [0005](0005-park-p2p-ship-neobank.md) | Park the P2P proximity thesis; ship the neobank first — **supersedes the original architecture** |
| [0006](0006-reject-skia-without-device.md) | Reject `react-native-skia` until there's a device to validate the 60fps condition |
| [0007](0007-pin-tailwind-v3.md) | Pin `tailwindcss` to v3, despite NativeWind's version number suggesting v4 |
| [0008](0008-jwt-kid-keyed-rotation.md) | `kid`-keyed JWT signing keys, for near-free access-token rotation |
| [0009](0009-local-tls-caddy-mkcert.md) | Local TLS termination via Caddy + mkcert, not a self-signed cert in Node |
