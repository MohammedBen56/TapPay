import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { DetectedSubscription } from "@tappay/shared";
import { api } from "../../src/api/endpoints";
import { Card } from "../../src/components/Card";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { colors, type } from "../../src/design/tokens";
import { formatMAD, formatShortDate } from "../../src/design/format";

function SubscriptionRow({ subscription }: { subscription: DetectedSubscription }): React.JSX.Element {
  return (
    <Card style={styles.row}>
      <View style={styles.rowIcon}>
        <Ionicons name="repeat" size={18} color={colors.bone} />
      </View>
      <View style={styles.rowMiddle}>
        <Text style={styles.rowName}>{subscription.counterparty_name ?? "Unknown recipient"}</Text>
        <Text style={styles.rowMeta}>
          Every ~{subscription.average_interval_days} days — last paid {formatShortDate(subscription.last_paid_at)}
        </Text>
      </View>
      <Text style={styles.rowAmount}>{formatMAD(subscription.amount)} MAD</Text>
    </Card>
  );
}

/** Ship List v2 Wave 2 Phase 5: subscription tracking. Pure read-only
 * pattern detection (server/routes/subscriptions.ts) — no new stored
 * data, no write path. A heuristic, stated plainly to the user rather
 * than presented as a guarantee. */
export default function SubscriptionsScreen(): React.JSX.Element {
  const query = useQuery({ queryKey: ["subscriptions"], queryFn: api.subscriptions });
  const subscriptions = query.data?.subscriptions ?? [];

  return (
    <ScreenBackground>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.intro}>
          Recurring payments we&apos;ve noticed in your history — same recipient, same amount, roughly once a month.
          Not guaranteed to be complete or accurate.
        </Text>
        {query.isLoading ? null : subscriptions.length === 0 ? (
          <Text style={styles.emptyText}>Nothing recurring detected yet.</Text>
        ) : (
          <Animated.View entering={FadeIn.duration(200)} style={styles.gap12}>
            {subscriptions.map((s) => (
              <SubscriptionRow key={`${s.counterparty_account_id}:${s.amount}`} subscription={s} />
            ))}
          </Animated.View>
        )}
      </ScrollView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 20, paddingBottom: 60 },
  gap12: { gap: 12 },
  intro: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  emptyText: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, lineHeight: 20, textAlign: "center", paddingVertical: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.glassLow,
    alignItems: "center",
    justifyContent: "center",
  },
  rowMiddle: { flex: 1, gap: 2 },
  rowName: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone },
  rowMeta: { fontFamily: type.caption.family, fontSize: 12, color: colors.textTertiary },
  rowAmount: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone, fontVariant: ["tabular-nums"] },
});
