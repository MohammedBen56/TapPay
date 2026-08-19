import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import * as Print from "expo-print";
import { router, useLocalSearchParams } from "expo-router";
import * as Sharing from "expo-sharing";
import { useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import ViewShot, { type ViewShotRef } from "react-native-view-shot";
import { api } from "../../src/api/endpoints";
import { Card } from "../../src/components/Card";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { colors, radius, type } from "../../src/design/tokens";
import { formatDateTime, formatMAD, formatRibGrouped } from "../../src/design/format";

export default function TransferDetailScreen(): React.JSX.Element {
  const { txUuid } = useLocalSearchParams<{ txUuid: string }>();
  const { data: tx, isLoading } = useQuery({
    queryKey: ["transfer", txUuid],
    queryFn: () => api.transfer(txUuid),
    enabled: Boolean(txUuid),
  });
  const viewShotRef = useRef<ViewShotRef>(null);
  const [busy, setBusy] = useState<"image" | "pdf" | null>(null);

  const handleShareImage = async (): Promise<void> => {
    if (!viewShotRef.current?.capture) return;
    setBusy("image");
    try {
      const uri = await viewShotRef.current.capture();
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Share receipt" });
      }
    } catch {
      Alert.alert("Couldn't share", "Something went wrong capturing the receipt.");
    } finally {
      setBusy(null);
    }
  };

  const handleSharePdf = async (): Promise<void> => {
    if (!tx) return;
    setBusy("pdf");
    try {
      const html = receiptHtml(tx);
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: "Share receipt" });
      }
    } catch {
      Alert.alert("Couldn't share", "Something went wrong generating the PDF.");
    } finally {
      setBusy(null);
    }
  };

  if (isLoading || !tx) {
    return (
      <ScreenBackground style={styles.center}>
        <Text style={styles.mutedText}>Loading transaction…</Text>
      </ScreenBackground>
    );
  }

  const isCredit = tx.direction === "credit";

  return (
    <ScreenBackground>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Animated.View entering={FadeIn.duration(400)}>
          <ViewShot ref={viewShotRef} options={{ format: "png", quality: 1 }}>
            <Card solid style={styles.receiptCard}>
              <View style={[styles.statusIcon, isCredit ? styles.statusIconCredit : styles.statusIconDebit]}>
                <Ionicons name={isCredit ? "arrow-down" : "arrow-up"} size={26} color={colors.bone} />
              </View>
              <Text style={styles.amount}>
                {isCredit ? "+" : "-"}
                {formatMAD(tx.amount)} {tx.currency}
              </Text>
              <Text style={styles.directionLabel}>{isCredit ? "Received from" : "Sent to"}</Text>
              <Text style={styles.counterparty}>{tx.counterparty_name ?? "Unknown"}</Text>

              <View style={styles.divider} />

              <DetailRow label="Reference" value={tx.reference ?? "—"} />
              <DetailRow label="RIB" value={tx.counterparty_rib ? formatRibGrouped(tx.counterparty_rib) : "—"} />
              <DetailRow label="Date" value={formatDateTime(tx.created_at)} />
              <DetailRow label="Reference ID" value={tx.tx_uuid} mono />
            </Card>
          </ViewShot>
        </Animated.View>

        <View style={styles.actions}>
          <GlassButton label="Share as image" onPress={() => void handleShareImage()} loading={busy === "image"} />
          <GlassButton label="Save as PDF" variant="ghost" onPress={() => void handleSharePdf()} loading={busy === "pdf"} />
          <GlassButton label="Done" variant="ghost" onPress={() => router.back()} />
        </View>
      </ScrollView>
    </ScreenBackground>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono && styles.mono]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function receiptHtml(tx: {
  tx_uuid: string;
  direction: string;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_rib: string | null;
  reference: string | null;
  created_at: string;
}): string {
  const sign = tx.direction === "credit" ? "+" : "-";
  // Interpolated from the Argent palette (colors.ground/bone/textSecondary/
  // glassBorder) so this PDF can't drift from the app's tokens again --
  // previously hardcoded to the obsidian-era hexes directly in this string.
  // Font stack stays system -- embedding Newsreader/Schibsted as base64 is
  // out of scope for this reskin.
  return `
    <html>
      <body style="font-family: -apple-system, Helvetica, Arial, sans-serif; background:${colors.ground}; color:${colors.bone}; padding:40px;">
        <h1 style="font-size:14px; letter-spacing:2px; color:${colors.textSecondary}; text-transform:uppercase;">TapPay Receipt</h1>
        <p style="font-size:36px; margin:12px 0;">${sign}${formatMAD(tx.amount)} ${tx.currency}</p>
        <p style="color:${colors.textSecondary};">${tx.direction === "credit" ? "Received from" : "Sent to"} ${tx.counterparty_name ?? "Unknown"}</p>
        <hr style="border-color:${colors.glassBorder}; margin:24px 0;" />
        <table style="width:100%; font-size:14px;">
          <tr><td style="color:${colors.textSecondary}; padding:6px 0;">Reference</td><td style="text-align:right;">${tx.reference ?? "—"}</td></tr>
          <tr><td style="color:${colors.textSecondary}; padding:6px 0;">RIB</td><td style="text-align:right;">${tx.counterparty_rib ? formatRibGrouped(tx.counterparty_rib) : "—"}</td></tr>
          <tr><td style="color:${colors.textSecondary}; padding:6px 0;">Date</td><td style="text-align:right;">${formatDateTime(tx.created_at)}</td></tr>
          <tr><td style="color:${colors.textSecondary}; padding:6px 0;">Reference ID</td><td style="text-align:right; font-family: monospace; font-size:11px;">${tx.tx_uuid}</td></tr>
        </table>
      </body>
    </html>
  `;
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  mutedText: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary },
  scroll: { padding: 20, gap: 20, paddingBottom: 80 },
  receiptCard: { alignItems: "center", gap: 4, paddingVertical: 28, borderRadius: radius.xl },
  statusIcon: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  statusIconCredit: { backgroundColor: colors.creditTint },
  statusIconDebit: { backgroundColor: colors.debitTint },
  amount: { fontFamily: type.hero.family, fontSize: 36, color: colors.bone },
  directionLabel: { fontFamily: type.caption.family, fontSize: 13, color: colors.textSecondary, marginTop: 8 },
  counterparty: { fontFamily: type.bodyStrong.family, fontSize: 17, color: colors.bone, marginTop: 2 },
  divider: { alignSelf: "stretch", height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline, marginVertical: 20 },
  detailRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", alignSelf: "stretch", paddingVertical: 6 },
  detailLabel: { fontFamily: type.caption.family, fontSize: 13, color: colors.textSecondary },
  detailValue: { fontFamily: type.bodyStrong.family, fontSize: 14, color: colors.bone, maxWidth: "60%", textAlign: "right" },
  mono: { fontFamily: type.caption.family, fontSize: 11 },
  actions: { gap: 12 },
});
