import { Ionicons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useAuth } from "../../src/auth/AuthContext";
import { getBalanceVisible, setBalanceVisible } from "../../src/auth/balanceVisibility";
import { Card } from "../../src/components/Card";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { TransactionRow } from "../../src/components/TransactionRow";
import { api } from "../../src/api/endpoints";
import { colors, radius, type } from "../../src/design/tokens";
import { formatMAD } from "../../src/design/format";

export default function HomeScreen(): React.JSX.Element {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    void getBalanceVisible().then(setVisible);
  }, []);

  const balanceQuery = useQuery({ queryKey: ["balance"], queryFn: api.balance });
  const transactionsQuery = useQuery({ queryKey: ["transactions"], queryFn: () => api.transactions({ limit: 20 }) });

  const toggleVisible = (): void => {
    const next = !visible;
    setVisible(next);
    void setBalanceVisible(next);
  };

  const onRefresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["balance"] });
    void queryClient.invalidateQueries({ queryKey: ["transactions"] });
  };

  const transactions = transactionsQuery.data?.transactions ?? [];
  const balanceDisplay = balanceQuery.data ? formatMAD(balanceQuery.data.available_balance) : "----.--";

  return (
    <ScreenBackground>
      <View style={styles.container}>
        <Animated.View entering={FadeIn.duration(400)} style={styles.header}>
          <View>
            <Text style={styles.greeting}>Good to see you</Text>
            <Text style={styles.name}>{account?.display_name ?? "—"}</Text>
          </View>
        </Animated.View>

        <Animated.View entering={FadeIn.delay(80).duration(450)}>
          <Card style={styles.balanceCard}>
            <View style={styles.balanceRow}>
              <Text style={styles.balanceLabel}>Available balance</Text>
              <Pressable
                onPress={toggleVisible}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={visible ? "Hide balance" : "Show balance"}
                accessibilityHint={visible ? "Replaces the amount with dots" : "Reveals your available balance"}
              >
                <Ionicons name={visible ? "eye-outline" : "eye-off-outline"} size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.balanceAmount}>{visible ? `${balanceDisplay}` : "•••••••"}</Text>
            <Text style={styles.currency}>{visible ? (balanceQuery.data?.currency ?? "MAD") : " "}</Text>
            <GlassButton label="Send money" onPress={() => router.push("/(tabs)/send")} style={styles.sendButton} />
            <GlassButton label="Pay bills" variant="ghost" onPress={() => router.push("/bills")} style={styles.payBillsButton} />
          </Card>
        </Animated.View>

        <View style={styles.listHeader}>
          <Text style={styles.sectionLabel}>Recent activity</Text>
        </View>

        <FlashList
          data={transactions}
          keyExtractor={(tx) => tx.tx_uuid}
          renderItem={({ item }) => <TransactionRow tx={item} />}
          refreshControl={<RefreshControl refreshing={transactionsQuery.isFetching} onRefresh={onRefresh} tintColor={colors.bone} />}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            transactionsQuery.isLoading ? (
              <View style={styles.empty}>
                <ActivityIndicator color={colors.textTertiary} />
              </View>
            ) : (
              <View style={styles.empty}>
                <Ionicons name="receipt-outline" size={28} color={colors.textTertiary} />
                <Text style={styles.emptyText}>No transactions yet</Text>
                <Text style={styles.emptySubtext}>Your sends and receives will show up here.</Text>
              </View>
            )
          }
        />
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 12 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  greeting: { fontFamily: type.caption.family, fontSize: 13, color: colors.textSecondary },
  name: { fontFamily: type.screenTitle.family, fontSize: 22, color: colors.bone, marginTop: 2 },
  balanceCard: { alignItems: "center", gap: 4, paddingVertical: 28, borderRadius: radius.xl },
  balanceRow: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "stretch", justifyContent: "center" },
  balanceLabel: {
    fontFamily: type.sectionLabel.family,
    fontSize: type.sectionLabel.size,
    letterSpacing: type.sectionLabel.letterSpacing,
    color: colors.textQuiet,
    textTransform: "uppercase",
  },
  balanceAmount: { fontFamily: type.hero.family, fontSize: 46, color: colors.bone, marginTop: 4 },
  currency: {
    fontFamily: type.sectionLabel.family,
    fontSize: type.sectionLabel.size,
    letterSpacing: type.sectionLabel.letterSpacing,
    color: colors.textQuiet,
  },
  sendButton: { alignSelf: "stretch", marginTop: 20 },
  payBillsButton: { alignSelf: "stretch", marginTop: 12 },
  listHeader: { marginTop: 28, marginBottom: 4 },
  sectionLabel: {
    fontFamily: type.sectionLabel.family,
    fontSize: type.sectionLabel.size,
    letterSpacing: type.sectionLabel.letterSpacing,
    color: colors.textQuiet,
    textTransform: "uppercase",
  },
  listContent: { paddingBottom: 120 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline },
  empty: { alignItems: "center", gap: 8, paddingTop: 48 },
  emptyText: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone },
  emptySubtext: { fontFamily: type.caption.family, fontSize: 13, color: colors.textQuiet, textAlign: "center" },
});
