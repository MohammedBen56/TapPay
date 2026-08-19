import type { MeResponse } from "@tappay/shared";
import * as LocalAuthentication from "expo-local-authentication";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { api } from "../api/endpoints";
import {
  clearBiometricRefreshToken,
  getRefreshTokenViaBiometric,
  getSavedCustomerId,
  getSavedDisplayName,
  isBiometricEnabled,
  saveCustomerId,
  saveDisplayName,
  saveRefreshTokenForBiometric,
} from "./secureStore";
import { getTokens, setTokens } from "./tokenStore";

// "awaitingBiometricPrompt" sits between a successful password login and
// full access: it's the interstitial where the sign-in screen offers "Enable
// biometric sign-in?" before the Stack.Protected guard in app/_layout.tsx
// lets the user through to (tabs). Only entered after a PASSWORD login when
// biometric hardware is available and not yet enabled -- a biometric login
// has nothing new to offer here.
type AuthStatus = "loading" | "signedOut" | "awaitingBiometricPrompt" | "signedIn";

interface AuthContextValue {
  status: AuthStatus;
  account: MeResponse | null;
  savedCustomerId: string | null;
  savedDisplayName: string | null;
  biometricHardwareAvailable: boolean;
  biometricEnabled: boolean;
  loginError: string | null;
  loginWithPassword: (customerId: string, password: string) => Promise<boolean>;
  loginWithBiometric: () => Promise<boolean>;
  enableBiometric: () => Promise<boolean>;
  /** Dismisses the post-login biometric-enrollment interstitial (whether or
   * not the user chose to enable it) and grants full access. */
  finishBiometricPrompt: () => void;
  logout: () => Promise<void>;
  refreshAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [account, setAccount] = useState<MeResponse | null>(null);
  const [savedCustomerId, setSavedCustomerId] = useState<string | null>(null);
  const [savedDisplayName, setSavedDisplayName] = useState<string | null>(null);
  const [biometricHardwareAvailable, setBiometricHardwareAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [customerId, displayName, biometricAlreadyEnabled, hardware, enrolled] = await Promise.all([
        getSavedCustomerId(),
        getSavedDisplayName(),
        isBiometricEnabled(),
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (cancelled) return;
      setSavedCustomerId(customerId);
      setSavedDisplayName(displayName);
      setBiometricEnabled(biometricAlreadyEnabled);
      setBiometricHardwareAvailable(hardware && enrolled);
      setStatus("signedOut");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAccount = useCallback(async () => {
    const me = await api.me();
    setAccount(me);
    setSavedDisplayName(me.display_name);
    void saveDisplayName(me.display_name);
  }, []);

  const loginWithPassword = useCallback(
    async (customerId: string, password: string): Promise<boolean> => {
      setLoginError(null);
      try {
        const result = await api.login({ customer_id: customerId, password });
        setTokens({ accessToken: result.access_token, refreshToken: result.refresh_token });
        await saveCustomerId(customerId);
        setSavedCustomerId(customerId);
        await refreshAccount();
        setStatus(biometricHardwareAvailable && !biometricEnabled ? "awaitingBiometricPrompt" : "signedIn");
        return true;
      } catch (err) {
        setLoginError(err instanceof ApiError ? err.message : "unable to sign in -- check your connection");
        return false;
      }
    },
    [refreshAccount, biometricHardwareAvailable, biometricEnabled],
  );

  const loginWithBiometric = useCallback(async (): Promise<boolean> => {
    setLoginError(null);
    try {
      const refreshToken = await getRefreshTokenViaBiometric();
      if (!refreshToken) {
        return false; // user cancelled the prompt -- not an error worth surfacing
      }
      const result = await api.refresh({ refresh_token: refreshToken });
      setTokens({ accessToken: result.access_token, refreshToken: result.refresh_token });
      // Refresh tokens rotate on every use -- re-save so the NEXT biometric
      // unlock still works against a token the server still recognizes.
      await saveRefreshTokenForBiometric(result.refresh_token);
      setStatus("signedIn");
      await refreshAccount();
      return true;
    } catch {
      setLoginError("biometric sign-in failed -- use your password instead");
      return false;
    }
  }, [refreshAccount]);

  const enableBiometric = useCallback(async (): Promise<boolean> => {
    const tokens = getTokens();
    if (!tokens) return false;
    try {
      await saveRefreshTokenForBiometric(tokens.refreshToken);
      setBiometricEnabled(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  const finishBiometricPrompt = useCallback((): void => {
    setStatus("signedIn");
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    const tokens = getTokens();
    if (tokens) {
      try {
        await api.logout({ refresh_token: tokens.refreshToken });
      } catch {
        // Best-effort -- proceed with local sign-out even if the network call fails.
      }
    }
    setTokens(null);
    setAccount(null);
    await clearBiometricRefreshToken();
    setBiometricEnabled(false);
    setStatus("signedOut");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      account,
      savedCustomerId,
      savedDisplayName,
      biometricHardwareAvailable,
      biometricEnabled,
      loginError,
      loginWithPassword,
      loginWithBiometric,
      enableBiometric,
      finishBiometricPrompt,
      logout,
      refreshAccount,
    }),
    [
      status,
      account,
      savedCustomerId,
      savedDisplayName,
      biometricHardwareAvailable,
      biometricEnabled,
      loginError,
      loginWithPassword,
      loginWithBiometric,
      enableBiometric,
      finishBiometricPrompt,
      logout,
      refreshAccount,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
