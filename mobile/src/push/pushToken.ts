/** Ship List v2 Wave 2 Phase 8: push notifications. Requests notification
 * permission and registers the resulting Expo push token with the server
 * (POST /push-tokens). Called once per signed-in session
 * (AuthContext.tsx) -- best-effort and silent on failure, since push
 * registration must never surface an error to the user or block sign-in.
 *
 * **The real, stated boundary**: `Notifications.getExpoPushTokenAsync()`
 * needs a valid EAS project id, and `mobile/app.config.js`'s
 * `extra.eas.projectId` is confirmed still unset (the same
 * account-ownership boundary Ship List v2 Phase 7's release signing
 * already hit and deliberately left to the owner). This function is
 * written and typechecked to do the real thing once that id exists; until
 * then it throws inside the try below and this becomes a silent no-op on
 * every real device, which is the intended degrade-gracefully behavior,
 * not a bug -- see server/src/notifications.ts's matching header comment.
 */
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";

export async function registerPushToken(): Promise<void> {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    const finalStatus = existingStatus === "granted" ? existingStatus : (await Notifications.requestPermissionsAsync()).status;
    if (finalStatus !== "granted") return;

    const { data: token } = await Notifications.getExpoPushTokenAsync();
    await api.registerPushToken({ token, platform: Platform.OS === "ios" ? "ios" : "android" });
  } catch (err) {
    // Expected on every device until the owner links a real EAS project
    // id -- never let this reach the user as an error.
    if (__DEV__ && !(err instanceof ApiError)) {
      console.log("[push] registration skipped:", err instanceof Error ? err.message : String(err));
    }
  }
}
