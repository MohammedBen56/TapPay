import { StyleSheet, Text, View } from "react-native";
import { colors, type } from "../design/tokens";

/** A label/value row inside a review-and-confirm `Card`, used by both
 * Send's review step and the bill-pay confirm step. `emphasize` uses
 * `type.amount`'s tabular-nums grotesk, not the display serif -- CLAUDE.md
 * §8's type-hierarchy rule: a right-aligned money value needs digit
 * alignment a 200-weight serif can't give. */
export function ReviewRow({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, emphasize && styles.valueEmphasized]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontFamily: type.caption.family, fontSize: 13, color: colors.textSecondary },
  value: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone, maxWidth: "60%", textAlign: "right" },
  valueEmphasized: { fontFamily: type.amount.family, fontSize: 20, color: colors.bone },
});
