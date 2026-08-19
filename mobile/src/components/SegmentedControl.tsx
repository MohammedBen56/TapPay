import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, type } from "../design/tokens";

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({ options, value, onChange }: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <View style={styles.wrap}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable key={opt.value} onPress={() => onChange(opt.value)} style={[styles.segment, active && styles.segmentActive]}>
            <Text style={[styles.label, active && styles.labelActive]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    backgroundColor: colors.glassLow,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 4,
    gap: 4,
  },
  // Deliberately NOT platinum -- platinum is reserved for at most one
  // primary CTA per screen (see GlassButton.tsx's docblock).
  segment: { flex: 1, paddingVertical: 10, borderRadius: radius.sm - 4, alignItems: "center" },
  segmentActive: { backgroundColor: colors.glassActive, borderWidth: 1, borderColor: colors.glassBorderStrong },
  label: { fontFamily: type.caption.family, fontSize: 12, color: colors.textTertiary },
  labelActive: { color: colors.bone, fontFamily: type.bodyStrong.family },
});
