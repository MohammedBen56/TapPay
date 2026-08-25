/** Base URL for the mock neobank server (server/), through the local Caddy
 * TLS proxy (Caddyfile, docker-compose.yml's `caddy` service) -- closes D1
 * (CLAUDE.md §11): every request including POST /auth/login's password
 * field traveled plaintext http:// before this. Points at port 443
 * explicitly by omission (no `:port` suffix needed) since Caddy binds the
 * standard HTTPS port.
 *
 * Points at the dev host's LAN IP, not `localhost` -- found during M3
 * Milestone 2 live BLE testing that `adb reverse tcp:3000 tcp:3000`
 * (this app's original approach, still what the telemetry harness's
 * `adb reverse tcp:8080 tcp:8080` uses, see src/telemetry/TelemetryClient.ts)
 * drops intermittently under WSL2 wireless adb in this dev environment --
 * repeatedly, independently of the phone's actual WiFi connectivity, which
 * stayed solid the whole time. Metro's OWN dev-client bundle loading never
 * had this problem because Expo already talks to the LAN IP directly
 * ("Loading from <LAN IP>:8081...") rather than through a reverse tunnel --
 * this just applies the same fix to the server connection.
 *
 * This IS a real dev-only tradeoff, not a strict improvement: the LAN IP is
 * specific to whichever network this host is on and will need updating if
 * that changes -- when it does, also regenerate caddy/certs/ for the new IP
 * (Caddyfile's own comment has the exact mkcert command; the cert's
 * Subject Alternative Names are pinned to specific IPs, unlike a plain HTTP
 * proxy that doesn't care). Requires the phone and this host to be on the
 * same WiFi network -- true for this project's two-phone dev setup, and not
 * a new requirement (Metro's bundle loading already needed it). Until the
 * phone trusts the local mkcert CA (see mobile/DEVICE_TEST_MATRIX.md for
 * the one-time device-trust step, Ship List Phase 6), expect the OS to
 * reject this connection as an untrusted certificate -- that's correct
 * behavior, not a bug, and Phase 5's certificate pinning replaces this
 * manual-trust step entirely once it lands. */
export const SERVER_BASE_URL = 'https://192.168.1.52';
