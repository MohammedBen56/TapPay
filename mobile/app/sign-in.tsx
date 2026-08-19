import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { Card } from "../src/components/Card";
import { GlassButton } from "../src/components/GlassButton";
import { ScreenBackground } from "../src/components/ScreenBackground";
import { TextField } from "../src/components/TextField";
import { useAuth } from "../src/auth/AuthContext";
import { colors, type } from "../src/design/tokens";

export default function SignInScreen(): React.JSX.Element {
  const {
    status,
    savedCustomerId,
    savedDisplayName,
    biometricEnabled,
    loginError,
    loginWithPassword,
    loginWithBiometric,
    enableBiometric,
    finishBiometricPrompt,
  } = useAuth();

  const [customerId, setCustomerId] = useState(savedCustomerId ?? "");
  const [password, setPassword] = useState("");
  const [usePasswordEntry, setUsePasswordEntry] = useState(!biometricEnabled);
  const [submitting, setSubmitting] = useState(false);
  const [biometricSubmitting, setBiometricSubmitting] = useState(false);
  const [enabling, setEnabling] = useState(false);

  const showBiometricWelcome = biometricEnabled && !usePasswordEntry && Boolean(savedCustomerId);

  const handlePasswordSignIn = async (): Promise<void> => {
    if (!customerId.trim() || !password) return;
    setSubmitting(true);
    await loginWithPassword(customerId.trim(), password);
    setSubmitting(false);
    setPassword("");
  };

  const handleBiometricSignIn = async (): Promise<void> => {
    setBiometricSubmitting(true);
    const ok = await loginWithBiometric();
    setBiometricSubmitting(false);
    if (!ok) setUsePasswordEntry(true);
  };

  const handleEnableBiometric = async (): Promise<void> => {
    setEnabling(true);
    await enableBiometric();
    setEnabling(false);
    finishBiometricPrompt();
  };

  if (status === "locked") {
    return (
      <ScreenBackground style={styles.center}>
        <Animated.View entering={FadeInDown.duration(400)} style={styles.promptWrap}>
          <Card style={styles.promptCard}>
            <View style={styles.promptIcon}>
              <Ionicons name="lock-closed" size={32} color={colors.bone} />
            </View>
            <Text style={styles.promptTitle}>Session locked</Text>
            <Text style={styles.promptBody}>
              {biometricEnabled && !usePasswordEntry
                ? "Verify it's you to keep going."
                : "Enter your password to keep going."}
            </Text>
            {biometricEnabled && !usePasswordEntry ? (
              <>
                <GlassButton
                  label="Unlock with biometrics"
                  onPress={() => void handleBiometricSignIn()}
                  loading={biometricSubmitting}
                  style={styles.promptButton}
                />
                <Pressable onPress={() => setUsePasswordEntry(true)} accessibilityRole="button">
                  <Text style={styles.switchLabel}>Use password instead</Text>
                </Pressable>
              </>
            ) : (
              <View style={styles.gap}>
                <TextField
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="password"
                  placeholder="••••••••"
                  onSubmitEditing={() => void handlePasswordSignIn()}
                />
                {loginError ? <Text style={styles.errorBanner}>{loginError}</Text> : null}
                <GlassButton label="Unlock" onPress={() => void handlePasswordSignIn()} loading={submitting} disabled={!password} />
              </View>
            )}
          </Card>
        </Animated.View>
      </ScreenBackground>
    );
  }

  if (status === "awaitingBiometricPrompt") {
    return (
      <ScreenBackground style={styles.center}>
        <Animated.View entering={FadeInDown.duration(400)} style={styles.promptWrap}>
          <Card style={styles.promptCard}>
            <View style={styles.promptIcon}>
              <Ionicons name="finger-print" size={32} color={colors.bone} />
            </View>
            <Text style={styles.promptTitle}>Enable biometric sign-in?</Text>
            <Text style={styles.promptBody}>
              Next time, unlock TapPay with your fingerprint or face instead of typing your password.
            </Text>
            <GlassButton
              label="Enable biometric sign-in"
              onPress={() => void handleEnableBiometric()}
              loading={enabling}
              style={styles.promptButton}
            />
            <Pressable onPress={finishBiometricPrompt} accessibilityRole="button">
              <Text style={styles.skipLabel}>Not now</Text>
            </Pressable>
          </Card>
        </Animated.View>
      </ScreenBackground>
    );
  }

  return (
    <ScreenBackground>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Animated.View entering={FadeIn.duration(500)} style={styles.header}>
            <Text style={styles.wordmark}>TapPay</Text>
            <Text style={styles.tagline}>Private banking, in your pocket</Text>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(120).duration(450)}>
            <Card style={styles.formCard}>
              {showBiometricWelcome ? (
                <View style={styles.welcomeBack}>
                  <Text style={styles.welcomeLabel}>Welcome back</Text>
                  <Text style={styles.welcomeCustomerId}>{savedDisplayName?.split(" ")[0] ?? savedCustomerId}</Text>
                  <GlassButton
                    label="Sign in with biometrics"
                    onPress={() => void handleBiometricSignIn()}
                    loading={biometricSubmitting}
                    style={styles.gap}
                  />
                  <Pressable onPress={() => setUsePasswordEntry(true)} accessibilityRole="button">
                    <Text style={styles.switchLabel}>Use password instead</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.gap}>
                  <TextField
                    label="Customer ID"
                    value={customerId}
                    onChangeText={setCustomerId}
                    keyboardType="number-pad"
                    autoComplete="username"
                    maxLength={8}
                    placeholder="10000001"
                  />
                  <TextField
                    label="Password"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoComplete="password"
                    placeholder="••••••••"
                    onSubmitEditing={() => void handlePasswordSignIn()}
                  />
                  {loginError ? <Text style={styles.errorBanner}>{loginError}</Text> : null}
                  <GlassButton
                    label="Sign in"
                    onPress={() => void handlePasswordSignIn()}
                    loading={submitting}
                    disabled={!customerId.trim() || !password}
                  />
                  {biometricEnabled ? (
                    <Pressable onPress={() => setUsePasswordEntry(false)} accessibilityRole="button">
                      <Text style={styles.switchLabel}>Use biometrics instead</Text>
                    </Pressable>
                  ) : null}
                </View>
              )}
            </Card>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", padding: 24 },
  scroll: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 40 },
  header: { alignItems: "center", gap: 8 },
  wordmark: { fontFamily: type.hero.family, fontSize: 48, color: colors.bone, letterSpacing: -0.5 },
  tagline: { fontFamily: type.caption.family, fontSize: type.caption.size, color: colors.textSecondary, letterSpacing: 0.4 },
  formCard: { gap: 8 },
  gap: { gap: 16 },
  errorBanner: {
    fontFamily: type.caption.family,
    fontSize: type.caption.size,
    color: colors.danger,
    textAlign: "center",
  },
  switchLabel: {
    fontFamily: type.caption.family,
    fontSize: type.caption.size,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: 4,
    textDecorationLine: "underline",
  },
  welcomeBack: { gap: 16, alignItems: "center" },
  welcomeLabel: {
    fontFamily: type.sectionLabel.family,
    fontSize: type.sectionLabel.size,
    letterSpacing: type.sectionLabel.letterSpacing,
    color: colors.textQuiet,
    textTransform: "uppercase",
  },
  welcomeCustomerId: { fontFamily: type.screenTitle.family, fontSize: 24, color: colors.bone },
  promptWrap: { width: "100%" },
  promptCard: { alignItems: "center", gap: 12, padding: 28 },
  promptIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.glassHigh,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  promptTitle: { fontFamily: type.screenTitle.family, fontSize: 20, color: colors.bone, textAlign: "center" },
  promptBody: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, textAlign: "center", lineHeight: 20 },
  promptButton: { width: "100%", marginTop: 8 },
  skipLabel: { fontFamily: type.caption.family, fontSize: type.caption.size, color: colors.textQuiet, marginTop: 4 },
});
