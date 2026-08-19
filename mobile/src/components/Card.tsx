import { BlurView } from "expo-blur";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius } from "../design/tokens";

interface CardProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Skips the BlurView and uses a flat, opaque fill instead. Required for
   * any Card wrapped in a ViewShot capture (e.g. the transaction-detail
   * receipt's "Share as image") -- a BlurView inside a ViewShot capture is a
   * real risk of rendering black/transparent on Android's hardware-
   * accelerated surface, and a shared receipt image has no backdrop to blur
   * anyway. */
  solid?: boolean;
}

/** The Argent glass panel. Callers pass layout props (gap, padding,
 * alignItems) through `style` onto direct `children` -- the blur is an
 * absolutely-positioned sibling behind them, never a wrapper that would
 * introduce an inner content View and silently break that layout. */
export function Card({ children, style, solid }: CardProps): React.JSX.Element {
  return (
    <View style={[styles.card, solid && styles.solid, style]}>
      {!solid && <BlurView intensity={26} tint="dark" style={[StyleSheet.absoluteFill, styles.tint]} pointerEvents="none" />}
      <View style={styles.topHighlight} pointerEvents="none" />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    overflow: "hidden", // clips the blur (and the highlight line) to the corner radius
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 20,
    boxShadow: [{ offsetX: 0, offsetY: 12, blurRadius: 34, color: colors.glassDrop }],
  },
  solid: { backgroundColor: colors.surface },
  tint: { backgroundColor: colors.glass },
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.glassHighlight,
  },
});
