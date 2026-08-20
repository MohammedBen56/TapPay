import * as Haptics from "expo-haptics";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from "react-native";
import { ApiError } from "../../src/api/client";
import { api } from "../../src/api/endpoints";
import { useAuth } from "../../src/auth/AuthContext";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { TextField } from "../../src/components/TextField";
import { colors, type } from "../../src/design/tokens";

/** Ship List v2. Success revokes every active session server-side
 * (server/src/routes/auth.ts's change-password route) -- including this
 * one -- so this screen signs the app out locally right after, same as a
 * deliberate sign-out, rather than leaving the app pointed at a session
 * the server already invalidated. */
export default function ChangePasswordScreen(): React.JSX.Element {
  const { logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const canSubmit = currentPassword && newPassword && confirmPassword && !mismatch && !tooShort;

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await api.changePassword({ current_password: currentPassword, new_password: newPassword });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The server just revoked every session, including this one -- sign
      // out locally and let the user sign back in with the new password.
      await logout();
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof ApiError ? err.message : "Couldn't change your password -- check your connection and try again.");
      setSubmitting(false);
    }
  };

  return (
    <ScreenBackground>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.intro}>
            Changing your password signs you out everywhere -- you&apos;ll need to sign back in with your new password.
          </Text>
          <TextField
            label="Current password"
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry
            autoComplete="current-password"
            autoFocus
          />
          <TextField
            label="New password"
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            autoComplete="new-password"
            error={tooShort ? "Must be at least 8 characters." : null}
          />
          <TextField
            label="Confirm new password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            autoComplete="new-password"
            error={mismatch ? "Passwords don't match." : null}
            onSubmitEditing={() => void handleSubmit()}
          />
          {error ? <Text style={styles.errorBanner}>{error}</Text> : null}
          <GlassButton label="Change password" onPress={() => void handleSubmit()} disabled={!canSubmit} loading={submitting} />
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { padding: 20, gap: 20, paddingBottom: 80 },
  intro: { fontFamily: type.caption.family, fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
  errorBanner: { fontFamily: type.caption.family, fontSize: 13, color: colors.danger },
});
