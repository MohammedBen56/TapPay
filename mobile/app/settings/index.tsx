import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import * as LocalAuthentication from "expo-local-authentication";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useAuth } from "../../src/auth/AuthContext";
import { Card } from "../../src/components/Card";
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

  const handleToggleBiometric = async (next: boolean): Promise<void> => {
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

        <Text style={styles.sectionLabel}>Documents</Text>
        <Card style={styles.card}>
          <SettingsRow
            icon="document-text-outline"
            label="Statements & letters"
            sublabel="Export a statement or a proof-of-balance letter"
            onPress={() => router.push("/statements")}
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
});
