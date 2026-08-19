import type { TransactionSummary } from "@tappay/shared";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, type } from "../design/tokens";
import { formatMAD } from "../design/format";

export function TransactionRow({ tx }: { tx: TransactionSummary }): React.JSX.Element {
  const isCredit = tx.direction === "credit";
  const name = tx.counterparty_name ?? "Unknown";
  const date = new Date(tx.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

  return (
    <Pressable accessibilityRole="button"
      onPress={() => router.push({ pathname: "/transfer/[txUuid]", params: { txUuid: tx.tx_uuid } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.avatar, isCredit ? styles.avatarCredit : styles.avatarDebit]}>
        <Text style={styles.avatarInitial}>{name.charAt(0).toUpperCase()}</Text>
      </View>
      <View style={styles.middle}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {tx.reference ?? "No reference"} · {date}
        </Text>
      </View>
      <Text style={[styles.amount, { color: isCredit ? colors.creditText : colors.textPrimary }]}>
        {isCredit ? "+" : "-"}
        {formatMAD(tx.amount)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 14, gap: 12 },
  pressed: { opacity: 0.6 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  avatarCredit: { backgroundColor: colors.creditTint },
  avatarDebit: { backgroundColor: colors.debitTint },
  avatarInitial: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone },
  middle: { flex: 1, gap: 2 },
  name: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone },
  meta: { fontFamily: type.caption.family, fontSize: 12, color: colors.textQuiet },
  amount: { fontFamily: type.amount.family, fontSize: 15 },
});
