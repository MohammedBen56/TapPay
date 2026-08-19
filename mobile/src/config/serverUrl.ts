/** Base URL for the mock neobank server (server/).
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
 * specific to whichever network this host is on and will need updating (or
 * reverting to `http://localhost:3000` + `adb reverse tcp:3000 tcp:3000`,
 * still valid as a fallback) if that changes. Requires the phone and this
 * host to be on the same WiFi network -- true for this project's two-phone
 * dev setup, and not a new requirement (Metro's bundle loading already
 * needed it). */
export const SERVER_BASE_URL = 'http://192.168.1.23:3000';
