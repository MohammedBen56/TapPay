import * as LocalAuthentication from "expo-local-authentication";
import { useCallback } from "react";

/** Shared by every money-moving confirm step (Send, bill pay): if biometric
 * hardware isn't available/enrolled, proceeds without a prompt (nothing to
 * gate on); otherwise requires a successful `authenticateAsync` before
 * returning true. Same semantics as the inline hasHardwareAsync/
 * isEnrolledAsync/authenticateAsync sequence this replaces -- just shared. */
export function useBiometricConfirm(): (promptMessage: string) => Promise<boolean> {
  return useCallback(async (promptMessage: string): Promise<boolean> => {
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (!hasHardware || !isEnrolled) return true;
    const auth = await LocalAuthentication.authenticateAsync({ promptMessage });
    return auth.success;
  }, []);
}
