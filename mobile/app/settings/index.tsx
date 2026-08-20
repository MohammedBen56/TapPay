import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import * as Haptics from "expo-haptics";
import * as LocalAuthentication from "expo-local-authentication";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { api } from "../../src/api/endpoints";
import { ApiError } from "../../src/api/client";
import { meQueryOptions } from "../../src/api/queries";
import { useAuth } from "../../src/auth/AuthContext";
import { Card } from "../../src/components/Card";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { colors, type } from "../../src/design/tokens";

function SettingsRow({
  icon,
  label,
  sublabel,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  sublabel?: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={18} color={colors.bone} />
      </View>
      <View style={styles.rowMiddle}>
        <Text style={styles.rowLabel}>{label}</Text>
        {sublabel ? <Text style={styles.rowSublabel}>{sublabel}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
    </Pressable>
  );
}

/** Ship List v2: the account-hygiene surface Profile didn't have --
 * change password, biometric toggle, session/device management. Reached
 * from a new row in Profile; Profile itself (QR, RIB, share, sign out)
 * stays unchanged. */
export default function SettingsScreen(): React.JSX.Element {
  const { biometricHardwareAvailable, biometricEnabled, enableBiometric, disableBiometric } = useAuth();
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricError, setBiometricError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const hasSavings = accountsQuery.data?.accounts.some((a) => a.account_type === "savings") ?? false;
  const [openingSavings, setOpeningSavings] = useState(false);
  const [openSavingsError, setOpenSavingsError] = useState<string | null>(null);

  // Ship List v2 Wave 2 Phase 5.
  const meQuery = useQuery(meQueryOptions);
  const [roundUpBusy, setRoundUpBusy] = useState(false);
  const [roundUpError, setRoundUpError] = useState<string | null>(null);

  const handleToggleRoundUp = async (next: boolean): Promise<void> => {
    setRoundUpError(null);
    setRoundUpBusy(true);
    try {
      await api.updateMe({ round_up_enabled: next });
      void Haptics.selectionAsync();
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setRoundUpError(err instanceof ApiError ? err.message : "Couldn't update round-up savings -- try again.");
    } finally {
      setRoundUpBusy(false);
    }
  };

  const handleOpenSavings = async (): Promise<void> => {
    setOpenSavingsError(null);
    setOpeningSavings(true);
    try {
      await api.openAccount({ account_type: "savings" });
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setOpenSavingsError(err instanceof ApiError ? err.message : "Couldn't open a savings account -- try again.");
    } finally {
      setOpeningSavings(false);
    }
  };

  const handleToggleBiometric = async (next: boolean): Promise<void> => {
    void Haptics.selectionAsync();
    setBiometricError(null);
    if (!next) {
      setBiometricBusy(true);
      try {
        await disableBiometric();
      } finally {
        setBiometricBusy(false);
      }
      return;
    }
    setBiometricBusy(true);
    try {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (!hasHardware || !isEnrolled) {
        setBiometricError("No biometric enrolled on this device -- add one in your device settings first.");
        return;
      }
      const ok = await enableBiometric();
      if (!ok) {
        setBiometricError("Couldn't enable biometric sign-in -- try again.");
      }
    } finally {
      setBiometricBusy(false);
    }
  };

  return (
    <ScreenBackground>
      <View style={styles.container}>
        <Text style={styles.sectionLabel}>Security</Text>
        <Card style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={styles.rowIcon}>
              <Ionicons name="finger-print" size={18} color={colors.bone} />
            </View>
            <View style={styles.rowMiddle}>
              <Text style={styles.rowLabel}>Biometric sign-in</Text>
              <Text style={styles.rowSublabel}>
                {biometricHardwareAvailable ? "Unlock with fingerprint or face" : "Not available on this device"}
              </Text>
            </View>
            <Switch
              value={biometricEnabled}
              onValueChange={(next) => void handleToggleBiometric(next)}
              disabled={biometricBusy || !biometricHardwareAvailable}
              accessibilityLabel="Biometric sign-in"
              accessibilityHint={biometricEnabled ? "Turns off fingerprint or face unlock" : "Turns on fingerprint or face unlock"}
            />
          </View>
          {biometricError ? <Text style={styles.errorText}>{biometricError}</Text> : null}
        </Card>

        <Card style={styles.card}>
          <SettingsRow icon="key-outline" label="Change password" onPress={() => router.push("/settings/change-password")} />
          <View style={styles.divider} />
          <SettingsRow
            icon="phone-portrait-outline"
            label="Manage devices"
            sublabel="See and sign out other active sessions"
            onPress={() => router.push("/settings/sessions")}
          />
        </Card>

        <Text style={styles.sectionLabel}>Accounts</Text>
        {!hasSavings ? (
          <Card style={styles.card}>
            <Text style={styles.disclosure}>
              Open a savings account to keep money separate and earn interest on it, with instant transfers to and
              from checking.
            </Text>
            {openSavingsError ? <Text style={styles.errorText}>{openSavingsError}</Text> : null}
            <GlassButton
              label="Open savings account"
              variant="ghost"
              onPress={() => void handleOpenSavings()}
              loading={openingSavings}
              style={styles.openSavingsButton}
            />
          </Card>
        ) : (
          <Card style={styles.card}>
            <View style={styles.toggleRow}>
              <View style={styles.rowIcon}>
                <Ionicons name="arrow-up-circle-outline" size={18} color={colors.bone} />
              </View>
              <View style={styles.rowMiddle}>
                <Text style={styles.rowLabel}>Round-up savings</Text>
                <Text style={styles.rowSublabel}>Round sends up to the next MAD, sweep the difference to savings</Text>
              </View>
              <Switch
                value={meQuery.data?.round_up_enabled ?? false}
                onValueChange={(next) => void handleToggleRoundUp(next)}
                disabled={roundUpBusy || !meQuery.data}
                accessibilityLabel="Round-up savings"
                accessibilityHint={
                  meQuery.data?.round_up_enabled ? "Turns off round-up savings" : "Turns on round-up savings"
                }
              />
            </View>
            {roundUpError ? <Text style={styles.errorText}>{roundUpError}</Text> : null}
            <View style={styles.divider} />
            <SettingsRow icon="flag-outline" label="Goals" sublabel="Track savings toward something specific" onPress={() => router.push("/goals")} />
          </Card>
        )}

        <Text style={styles.sectionLabel}>Insights</Text>
        <Card style={styles.card}>
          <SettingsRow
            icon="repeat-outline"
            label="Subscriptions"
            sublabel="Recurring payments we've noticed"
            onPress={() => router.push("/subscriptions")}
          />
        </Card>

        <Text style={styles.sectionLabel}>Documents</Text>
        <Card style={styles.card}>
          <SettingsRow
            icon="document-text-outline"
            label="Statements & letters"
            sublabel="Export a statement or a proof-of-balance letter"
            onPress={() => router.push("/statements")}
          />
        </Card>

        <Text style={styles.sectionLabel}>Support</Text>
        <Card style={styles.card}>
          <SettingsRow
            icon="help-circle-outline"
            label="Help"
            sublabel="FAQ and contact us"
            onPress={() => router.push("/help")}
          />
        </Card>

        <Text style={styles.sectionLabel}>About</Text>
        <Card style={styles.card}>
          <Text style={styles.disclosure}>
            TapPay is a demo product. It moves no real funds and is not a licensed bank.
          </Text>
        </Card>
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 20, gap: 20, paddingBottom: 40 },
  sectionLabel: {
    fontFamily: type.sectionLabel.family,
    fontSize: type.sectionLabel.size,
    letterSpacing: type.sectionLabel.letterSpacing,
    color: colors.textQuiet,
    textTransform: "uppercase",
    marginBottom: -8,
  },
  card: { gap: 0, padding: 8 },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, paddingHorizontal: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 12 },
  rowPressed: { backgroundColor: colors.glassLow },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.glassLow,
  },
  rowMiddle: { flex: 1, gap: 2 },
  rowLabel: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone },
  rowSublabel: { fontFamily: type.caption.family, fontSize: 12, color: colors.textQuiet },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline, marginVertical: 4, marginLeft: 46 },
  errorText: { fontFamily: type.caption.family, fontSize: 13, color: colors.danger, paddingHorizontal: 8, paddingBottom: 8 },
  disclosure: { fontFamily: type.caption.family, fontSize: 13, color: colors.textTertiary, lineHeight: 19, padding: 8 },
  openSavingsButton: { margin: 8, marginTop: 4 },
});
