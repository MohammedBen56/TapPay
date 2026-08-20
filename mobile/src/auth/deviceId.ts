/** Ship List v2 Wave 2 Phase 4 -- a random id generated once per app
 * install and persisted, sent as `X-Device-Id` on POST /auth/login only
 * (server/src/auth/deviceFingerprint.ts hashes it into the login-anomaly
 * fingerprint). Not a security control: the server never trusts this value
 * for an access decision, only to flag a login from a fingerprint it
 * hasn't seen before for that customer (an audit-log review signal). A
 * reinstall or a cleared SecureStore produces a new id, which just reads
 * as "new device" once -- an accepted, named limitation (deviceFingerprint.ts's
 * own doc comment), not a bug. Plain SecureStore key, no authentication
 * gate -- same storage mechanism as balanceVisibility.ts's UI-preference
 * tier, since this carries no more sensitivity than that. */
import * as SecureStore from "expo-secure-store";
import { uuidv4 } from "../util/uuid";

const KEY = "tappay.deviceId";

export async function getDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY);
  if (existing) return existing;
  const fresh = uuidv4();
  await SecureStore.setItemAsync(KEY, fresh);
  return fresh;
}
