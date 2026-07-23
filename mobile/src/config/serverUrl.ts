/** Base URL for the mock neobank server (server/). Dev default assumes
 * `adb reverse tcp:3000 tcp:3000`, mirroring the telemetry harness's own
 * `adb reverse tcp:8080 tcp:8080` pattern (see src/telemetry/TelemetryClient.ts /
 * CLAUDE.md §9). */
export const SERVER_BASE_URL = 'http://localhost:3000';
