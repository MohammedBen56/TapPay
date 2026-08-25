import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect } from "expo-router";
import * as Sharing from "expo-sharing";
import { useCallback, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import Animated, { FadeIn } from "react-native-reanimated";
import ViewShot, { type ViewShotRef } from "react-native-view-shot";
import { meQueryOptions } from "../../src/api/queries";
import { useAuth } from "../../src/auth/AuthContext";
import { Card } from "../../src/components/Card";
import { ConfirmDialog } from "../../src/components/ConfirmDialog";
import { GlassButton } from "../../src/components/GlassButton";
import { NfcSharingOverlay } from "../../src/components/NfcSharingOverlay";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { colors, type } from "../../src/design/tokens";
import { formatRibGrouped } from "../../src/design/format";
import { encodeProfileQr } from "../../src/qr/profileQr";
import { startNfcSharing, stopNfcSharing } from "../../src/nfc/nfcHce";

export default function ProfileScreen(): React.JSX.Element {
  const { logout } = useAuth();
  const meQuery = useQuery(meQueryOptions);
  const viewShotRef = useRef<ViewShotRef>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [nfcSharing, setNfcSharing] = useState(false);

  const me = meQuery.data;
  const qrValue = me ? encodeProfileQr({ rib: me.rib, display_name: me.display_name }) : "";

  // Never leave the HCE service serving a stale payload once this screen
  // isn't visible -- covers navigating away mid-share, not just an explicit
  // "Done" tap.
  useFocusEffect(
    useCallback(() => {
      return () => {
        void stopNfcSharing();
        setNfcSharing(false);
      };
    }, []),
  );

  const handleCopyRib = async (): Promise<void> => {
    if (!me) return;
    await Clipboard.setStringAsync(me.rib);
    void Haptics.selectionAsync();
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleShareImage = async (): Promise<void> => {
    if (!viewShotRef.current?.capture) return;
    try {
      const uri = await viewShotRef.current.capture();
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Share TapPay QR" });
      }
    } catch {
      Alert.alert("Couldn't share", "Something went wrong capturing the QR image.");
    }
  };

  const handleShareText = async (): Promise<void> => {
    if (!me) return;
    await Share.share({
      message: `${me.display_name}\nTapPay RIB: ${formatRibGrouped(me.rib)}\nIBAN: ${me.iban}`,
    });
  };

  const handleSignOut = (): void => setConfirmingSignOut(true);

  if (!me) {
    return (
      <ScreenBackground style={styles.center}>
        <Text style={styles.mutedText}>Loading profile…</Text>
      </ScreenBackground>
    );
  }

  return (
    <ScreenBackground>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Animated.View entering={FadeIn.duration(400)} style={styles.header}>
          <Text style={styles.headerTitle}>Profile</Text>
        </Animated.View>

        <Animated.View entering={FadeIn.delay(80).duration(450)}>
          <Card style={styles.qrCard}>
            <ViewShot ref={viewShotRef} options={{ format: "png", quality: 1 }}>
              <View style={styles.qrCapture}>
                <QRCode value={qrValue} size={200} color={colors.ground} backgroundColor={colors.bone} />
                <Text style={styles.captureDisplayName}>{me.display_name}</Text>
                <Text style={styles.captureRib}>{formatRibGrouped(me.rib)}</Text>
              </View>
            </ViewShot>
            <Text style={styles.name}>{me.display_name}</Text>
            <Text style={styles.customerId}>Customer ID {me.customer_id}</Text>
          </Card>
        </Animated.View>

        <Card style={styles.detailsCard}>
          <DetailRow label="RIB" value={formatRibGrouped(me.rib)} />
          <DetailRow label="IBAN" value={me.iban} />
          <DetailRow label="Currency" value={me.currency} />
          <Pressable onPress={() => void handleCopyRib()} style={styles.copyRow} accessibilityRole="button">
            <Ionicons name={copied ? "checkmark" : "copy-outline"} size={16} color={colors.bone} />
            <Text style={styles.copyLabel}>{copied ? "Copied" : "Copy RIB"}</Text>
          </Pressable>
        </Card>

        <View style={styles.actions}>
          <GlassButton label="Share QR image" onPress={() => void handleShareImage()} />
          <GlassButton label="Share as text" variant="ghost" onPress={() => void handleShareText()} />
          <GlassButton
            label="Share via NFC"
            variant="ghost"
            onPress={() => {
              void startNfcSharing(qrValue);
              setNfcSharing(true);
            }}
          />
          <GlassButton label="Settings" variant="ghost" onPress={() => router.push("/settings")} />
        </View>

        <GlassButton label="Sign out" variant="danger" onPress={handleSignOut} style={styles.signOut} />
      </ScrollView>

      {nfcSharing && (
        <NfcSharingOverlay
          body="Bring the back of this phone close to the other person's phone to share your account info."
          onDone={() => {
            void stopNfcSharing();
            setNfcSharing(false);
          }}
        />
      )}

      <ConfirmDialog
        visible={confirmingSignOut}
        title="Sign out?"
        message="You'll need your password or biometrics to sign back in."
        confirmLabel="Sign out"
        onCancel={() => setConfirmingSignOut(false)}
        onConfirm={() => {
          setConfirmingSignOut(false);
          void logout();
        }}
      />
    </ScreenBackground>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  mutedText: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary },
  scroll: { padding: 20, gap: 20, paddingBottom: 120 },
  header: { marginBottom: 4 },
  headerTitle: { fontFamily: type.screenTitle.family, fontSize: 22, color: colors.bone },
  qrCard: { alignItems: "center", gap: 8, paddingVertical: 28 },
  qrCapture: { alignItems: "center", gap: 6, backgroundColor: colors.bone, padding: 20, borderRadius: 16 },
  captureDisplayName: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.ground, marginTop: 8 },
  captureRib: { fontFamily: type.caption.family, fontSize: 12, color: colors.ground },
  name: { fontFamily: type.screenTitle.family, fontSize: 20, color: colors.bone, marginTop: 12 },
  customerId: { fontFamily: type.caption.family, fontSize: 12, color: colors.textQuiet },
  detailsCard: { gap: 14 },
  detailRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  detailLabel: { fontFamily: type.caption.family, fontSize: 13, color: colors.textSecondary },
  detailValue: { fontFamily: type.bodyStrong.family, fontSize: 14, color: colors.bone },
  copyRow: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginTop: 4 },
  copyLabel: { fontFamily: type.caption.family, fontSize: 13, color: colors.bone },
  actions: { gap: 12 },
  signOut: { marginTop: 8 },
  nfcOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.scrim,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  nfcCardWrap: { width: "100%" },
  nfcCard: { alignItems: "center", gap: 12, padding: 28 },
  nfcIcon: {
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
  nfcDoneButton: { width: "100%", marginTop: 8 },
});
