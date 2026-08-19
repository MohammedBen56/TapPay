import { SERVER_BASE_URL } from '../../config/serverUrl';

/**
 * Live reachability probe for the mock neobank server, used to pick a
 * connectivity mode (Mode A/B/C, via @tappay/shared's evaluateConnectivity)
 * ahead of BLE/GATT (M3), where no wire signal exists yet for one phone to
 * learn the other's connectivity.
 *
 * Deliberately NOT @react-native-community/netinfo: that's a native module,
 * which would force an APK rebuild to verify this round (no device access --
 * see CLAUDE.md's current milestone status), and "the OS reports a network
 * interface is up" is the wrong predicate anyway -- a missing `adb reverse`
 * tunnel or a captive portal both report "online" while genuinely unable to
 * reach the server. GET /health actually round-trips to the server and (per
 * the server's H8 hardening) checks Postgres is reachable too, not just
 * process liveness -- "online" here means "a payment can actually settle
 * right now," not "some network interface exists."
 */
export async function probeServerReachable(timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVER_BASE_URL}/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string; db?: string };
    return body.status === 'ok' && body.db === 'ok';
  } catch {
    // Network error, timeout (AbortController fired), or a non-JSON body --
    // every one of these means "can't currently prove the server is
    // reachable," which is the same as "offline" for mode-selection purposes.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
