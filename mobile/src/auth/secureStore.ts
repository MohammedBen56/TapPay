/** Persisted auth material, expo-secure-store-backed (Android Keystore
 * behind the scenes). Two keys with very different sensitivity:
 *  - the customer ID is convenience-only (prefills the sign-in field) and
 *    is stored with no authentication gate.
 *  - the refresh token is the thing biometric sign-in unlocks, and is
 *    stored with `requireAuthentication: true` so reading it back always
 *    re-prompts biometric/device-credential -- never the password itself
 *    (docs/TapPay_v2_Technical_Design.md §6).
 * A third plain flag key tracks *whether* biometric is enabled without
 * requiring a prompt just to check -- SecureStore has no "does this key
 * exist" query that skips the authentication gate. */
import * as SecureStore from "expo-secure-store";

const CUSTOMER_ID_KEY = "tappay.customerId";
const DISPLAY_NAME_KEY = "tappay.displayName";
const REFRESH_TOKEN_KEY = "tappay.biometricRefreshToken";
const BIOMETRIC_FLAG_KEY = "tappay.biometricEnabled";

const AUTH_PROMPT = "Confirm it's you to sign in to TapPay";

export async function getSavedCustomerId(): Promise<string | null> {
  return SecureStore.getItemAsync(CUSTOMER_ID_KEY);
}

export async function saveCustomerId(customerId: string): Promise<void> {
  await SecureStore.setItemAsync(CUSTOMER_ID_KEY, customerId);
}

/** Convenience-only, same sensitivity tier as the customer ID -- lets the
 * sign-in / biometric-welcome screen greet by name before a network call
 * has ever happened this launch. */
export async function getSavedDisplayName(): Promise<string | null> {
  return SecureStore.getItemAsync(DISPLAY_NAME_KEY);
}

export async function saveDisplayName(displayName: string): Promise<void> {
  await SecureStore.setItemAsync(DISPLAY_NAME_KEY, displayName);
}

export async function isBiometricEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BIOMETRIC_FLAG_KEY)) === "1";
}

export async function saveRefreshTokenForBiometric(refreshToken: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, {
    requireAuthentication: true,
    authenticationPrompt: AUTH_PROMPT,
  });
  await SecureStore.setItemAsync(BIOMETRIC_FLAG_KEY, "1");
}

/** Prompts biometric/device-credential to decrypt. Returns null if the user
 * cancels, if authentication fails, or if biometric was never enabled. */
export async function getRefreshTokenViaBiometric(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY, {
      requireAuthentication: true,
      authenticationPrompt: AUTH_PROMPT,
    });
  } catch {
    return null;
  }
}

export async function clearBiometricRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  await SecureStore.deleteItemAsync(BIOMETRIC_FLAG_KEY);
}
