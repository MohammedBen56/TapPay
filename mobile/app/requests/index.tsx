import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import Animated, { FadeIn } from "react-native-reanimated";
import type { MoneyRequest } from "@tappay/shared";
import { api } from "../../src/api/endpoints";
import { ApiError } from "../../src/api/client";
import { Card } from "../../src/components/Card";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { colors, type } from "../../src/design/tokens";
import { formatMAD, formatShortDate } from "../../src/design/format";
import { encodeRequestQr } from "../../src/qr/profileQr";
import { startNfcSharing, stopNfcSharing } from "../../src/nfc/nfcHce";

function statusLabel(status: MoneyRequest["status"]): string {
  if (status === "fulfilled") return "Paid";
  if (status === "declined") return "Declined";
  return "Pending";
}

function IncomingRow({ request, onRefresh }: { request: MoneyRequest; onRefresh: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState<"pay" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePay = async (): Promise<void> => {
    setError(null);
    setBusy("pay");
    try {
      await api.fulfillMoneyRequest(request.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onRefresh();
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof ApiError ? err.message : "Couldn't pay this request -- try again.");
    } finally {
      setBusy(null);
    }
  };

  const handleDecline = async (): Promise<void> => {
    setError(null);
    setBusy("decline");
    try {
      await api.declineMoneyRequest(request.id);
      void Haptics.selectionAsync();
      onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't decline this request -- try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card style={styles.row}>
      <View style={styles.rowHeader}>
        <View style={styles.rowMiddle}>
          <Text style={styles.rowName}>{request.requester.display_name ?? "Someone"}</Text>
          <Text style={styles.rowMeta}>{request.reference}</Text>
        </View>
        <Text style={styles.rowAmount}>{formatMAD(request.amount)} MAD</Text>
      </View>
      {request.status === "pending" ? (
        <>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.rowActions}>
            <GlassButton label="Decline" variant="ghost" onPress={() => void handleDecline()} loading={busy === "decline"} style={styles.rowButton} />
            <GlassButton label="Pay" variant="ghost" onPress={() => void handlePay()} loading={busy === "pay"} style={styles.rowButton} />
          </View>
        </>
      ) : (
        <Text style={styles.statusText}>{statusLabel(request.status)}</Text>
      )}
    </Card>
  );
}

function OutgoingRow({ request }: { request: MoneyRequest }): React.JSX.Element {
  const [sharing, setSharing] = useState(false);

  const qrValue =
    request.status === "pending" && request.requester.rib
      ? encodeRequestQr({
          type: "request",
          request_id: request.id,
          rib: request.requester.rib,
          display_name: request.requester.display_name ?? "",
          amount: request.amount,
          reference: request.reference,
        })
      : "";

  useFocusEffect(
    useCallback(() => {
      return () => {
        void stopNfcSharing();
        setSharing(false);
      };
    }, []),
  );

  return (
    <Card style={styles.row}>
      <View style={styles.rowHeader}>
        <View style={styles.rowMiddle}>
          <Text style={styles.rowName}>{request.target.display_name ?? "Someone"}</Text>
          <Text style={styles.rowMeta}>
            {request.reference} -- {formatShortDate(request.created_at)}
          </Text>
        </View>
        <Text style={styles.rowAmount}>{formatMAD(request.amount)} MAD</Text>
      </View>
      {request.status === "pending" ? (
        sharing ? (
          <View style={styles.qrWrap}>
            <QRCode value={qrValue} size={160} color={colors.ground} backgroundColor={colors.bone} />
            <Text style={styles.qrHint}>Let them scan this in Send, or hold phones together to share via NFC.</Text>
            <View style={styles.rowActions}>
              <GlassButton
                label="Share via NFC"
                variant="ghost"
                onPress={() => void startNfcSharing(qrValue)}
                style={styles.rowButton}
              />
              <GlassButton
                label="Done"
                variant="ghost"
                onPress={() => {
                  void stopNfcSharing();
                  setSharing(false);
                }}
                style={styles.rowButton}
              />
            </View>
          </View>
        ) : (
          <GlassButton label="Show QR / NFC" variant="ghost" onPress={() => setSharing(true)} style={styles.showQrButton} />
        )
      ) : (
        <Text style={styles.statusText}>{statusLabel(request.status)}</Text>
      )}
    </Card>
  );
}

/** Ship List v2 Wave 2 Phase 7: "request money" core. Fulfillment reuses
 * the same POST /transfers-style settlement path (server/routes/
 * moneyRequests.ts), so a paid request shows up in the normal
 * transaction history too. QR/NFC on an outgoing request is a DELIVERY
 * mechanism for an already-targeted request, not a way to let anyone
 * fulfill it -- only the named target can pay or decline. */
export default function MoneyRequestsScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["money-requests"], queryFn: api.moneyRequests });
  const [tab, setTab] = useState<"incoming" | "outgoing">("incoming");

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["money-requests"] });
    void queryClient.invalidateQueries({ queryKey: ["balance"] });
    void queryClient.invalidateQueries({ queryKey: ["transactions"] });
  };

  const incoming = query.data?.incoming ?? [];
  const outgoing = query.data?.outgoing ?? [];
  const pendingIncomingCount = incoming.filter((r) => r.status === "pending").length;

  return (
    <ScreenBackground>
      <ScrollView contentContainerStyle={styles.scroll}>
        <SegmentedControl
          options={[
            { value: "incoming", label: pendingIncomingCount > 0 ? `Owed to you (${pendingIncomingCount})` : "Owed to you" },
            { value: "outgoing", label: "You requested" },
          ]}
          value={tab}
          onChange={setTab}
        />

        <Animated.View entering={FadeIn.duration(200)} style={styles.gap12}>
          {tab === "incoming" &&
            (incoming.length === 0 ? (
              <Text style={styles.emptyText}>No one has requested money from you.</Text>
            ) : (
              incoming.map((r) => <IncomingRow key={r.id} request={r} onRefresh={refresh} />)
            ))}
          {tab === "outgoing" &&
            (outgoing.length === 0 ? (
              <Text style={styles.emptyText}>You haven&apos;t requested money from anyone yet.</Text>
            ) : (
              outgoing.map((r) => <OutgoingRow key={r.id} request={r} />)
            ))}
        </Animated.View>

        <GlassButton label="Request money" onPress={() => router.push("/requests/new")} />
      </ScrollView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 20, paddingBottom: 60 },
  gap12: { gap: 12 },
  emptyText: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, lineHeight: 20, textAlign: "center", paddingVertical: 20 },
  row: { gap: 12 },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  rowMiddle: { flex: 1, gap: 2 },
  rowName: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone },
  rowMeta: { fontFamily: type.caption.family, fontSize: 12, color: colors.textTertiary },
  rowAmount: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone, fontVariant: ["tabular-nums"] },
  rowActions: { flexDirection: "row", gap: 12 },
  rowButton: { flex: 1 },
  statusText: { fontFamily: type.caption.family, fontSize: 12, color: colors.textTertiary },
  errorText: { fontFamily: type.caption.family, fontSize: 13, color: colors.danger },
  showQrButton: { alignSelf: "flex-start" },
  qrWrap: { alignItems: "center", gap: 12 },
  qrHint: { fontFamily: type.caption.family, fontSize: 12, color: colors.textTertiary, textAlign: "center" },
});
