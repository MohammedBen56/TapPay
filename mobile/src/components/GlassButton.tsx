import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { ActivityIndicator, StyleSheet, Text, Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { colors, radius, type } from "../design/tokens";

/**
 * Argent's button treatment. `variant="primary"` is a flat platinum gradient
 * fill -- a deliberate reversal of the obsidian era's glass-with-gold-border
 * primary button (see CLAUDE.md section 8 for the full record: that button
 * was glass because a flat GOLD fill read as "too AI-generated"; platinum is
 * a neutral metal, not a saturated brand hue, which is the distinction that
 * makes this not the same mistake). `variant="ghost"`/`"danger"` keep the
 * glass treatment, now a flat 1px hairline border instead of the old
 * gradient border wrapper -- Argent's borders are flat, not metallic.
 *
 * Corollary rule (also in CLAUDE.md section 8): at most one platinum button
 * per screen. Every secondary action stays ghost -- that's what keeps this
 * direction from degrading into "everything is a shiny chip."
 */
export type GlassButtonVariant = "primary" | "ghost" | "danger";

interface GlassButtonProps {
  label: string;
  onPress: () => void;
  variant?: GlassButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

const GLASS_FILL: Record<"ghost" | "danger", string> = {
  ghost: colors.glassLow,
  danger: colors.dangerTint,
};

const GLASS_BORDER: Record<"ghost" | "danger", string> = {
  ghost: colors.glassBorder,
  danger: "rgba(193,92,79,0.45)",
};

const TEXT_COLORS: Record<GlassButtonVariant, string> = {
  primary: colors.ink,
  ghost: colors.bone,
  danger: colors.danger,
};

export function GlassButton({
  label,
  onPress,
  variant = "primary",
  disabled,
  loading,
  style,
  accessibilityHint,
}: GlassButtonProps): React.JSX.Element {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const isDisabled = disabled || loading;

  const content = loading ? (
    <ActivityIndicator color={TEXT_COLORS[variant]} />
  ) : (
    <Text style={[styles.label, { color: TEXT_COLORS[variant] }]}>{label}</Text>
  );

  return (
    <Animated.View style={[animatedStyle, style]}>
      <Pressable
        disabled={isDisabled}
        onPressIn={() => {
          // Reanimated's useSharedValue().value assignment IS the API (a
          // mutable ref-like object the UI thread reads directly), not React
          // state -- the compiler's static analysis doesn't know about
          // Reanimated's model and flags every shared-value write as an
          // illegal mutation.
          // eslint-disable-next-line react-hooks/immutability
          scale.value = withSpring(0.97, { damping: 18, stiffness: 260 });
        }}
        onPressOut={() => {
          // eslint-disable-next-line react-hooks/immutability -- see above
          scale.value = withSpring(1, { damping: 18, stiffness: 260 });
        }}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onPress();
        }}
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled }}
        accessibilityHint={accessibilityHint}
      >
        {variant === "primary" ? (
          <LinearGradient
            colors={[colors.platinumLight, colors.platinumMid, colors.platinumDeep]}
            locations={[0, 0.52, 1]}
            start={{ x: 0.18, y: 0 }}
            end={{ x: 0.82, y: 1 }}
            style={[styles.primaryFill, isDisabled && styles.disabled]}
          >
            <View style={styles.inner}>{content}</View>
          </LinearGradient>
        ) : (
          <View
            style={[
              styles.glassFill,
              { backgroundColor: GLASS_FILL[variant], borderColor: GLASS_BORDER[variant] },
              isDisabled && styles.disabled,
            ]}
          >
            <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} pointerEvents="none" />
            <View style={styles.inner}>{content}</View>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  primaryFill: {
    borderRadius: radius.md,
    overflow: "hidden",
    boxShadow: [
      { offsetX: 0, offsetY: 1, blurRadius: 0, color: "rgba(255,255,255,0.55)", inset: true },
      { offsetX: 0, offsetY: 8, blurRadius: 22, color: "rgba(0,0,0,0.30)" },
    ],
  },
  glassFill: { borderRadius: radius.md, overflow: "hidden", borderWidth: 1 },
  inner: { paddingVertical: 16, alignItems: "center", justifyContent: "center" },
  label: { fontFamily: type.bodyStrong.family, fontSize: 16, letterSpacing: 0.2 },
  disabled: { opacity: 0.45 },
});
