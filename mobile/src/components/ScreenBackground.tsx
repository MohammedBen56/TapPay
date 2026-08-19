import { useEffect } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../design/tokens";

/**
 * The Argent ground every screen sits on: a flat near-black fill with four
 * large, low-opacity radial-gradient blobs drifting slowly behind a glass
 * layer. This REVERSES an earlier obsidian-era decision that the background
 * was deliberately non-animated -- device testing at the time found a
 * drifting gold sheen swept across the balance card distracting/gimmicky.
 * That was a decorative highlight competing with the number the user came
 * to read; these blobs are a different mechanism (large, low-opacity, sit
 * behind blurred glass, drift on 24-32s cycles -- ~imperceptible per-frame
 * motion) and are an owner-approved art direction via the Argent canvas, not
 * an implementer's flourish. See CLAUDE.md section 8 for the full record.
 *
 * UNVERIFIED ON THE A51 (SM-A515F) as of this writing -- the load-bearing
 * test is Home with the FlashList scrolling under the blobs. Two tuning
 * knobs exist for exactly that: turn ANIMATE_BLOBS off first, then drop to
 * fewer blobs if it's still not holding 60fps. Same rule that vetoed Skia
 * elsewhere in this app applies here: do not ship a janky background.
 */
const ANIMATE_BLOBS = true;
const BLOB_FIELD_OPACITY = 0.6;

interface Blob {
  color: string;
  size: number;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  dx: number;
  dy: number;
  scale: number;
  ms: number;
}

const BLOBS: Blob[] = [
  { color: colors.blobBlue, size: 460, top: -80, left: -110, dx: 70, dy: 50, scale: 1.18, ms: 26000 },
  { color: colors.blobViolet, size: 400, top: 120, right: -140, dx: -60, dy: 80, scale: 1.14, ms: 31000 },
  { color: colors.blobTeal, size: 380, bottom: 160, left: -120, dx: 80, dy: -60, scale: 1.2, ms: 24000 },
  { color: colors.blobSand, size: 420, bottom: -110, right: -90, dx: -50, dy: -70, scale: 1.12, ms: 29000 },
];

function BlobLayer({ blob }: { blob: Blob }): React.JSX.Element {
  const p = useSharedValue(0);

  useEffect(() => {
    if (ANIMATE_BLOBS) {
      p.value = withRepeat(withTiming(1, { duration: blob.ms, easing: Easing.inOut(Easing.ease) }), -1, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(p.value, [0, 1], [0, blob.dx]) },
      { translateY: interpolate(p.value, [0, 1], [0, blob.dy]) },
      { scale: interpolate(p.value, [0, 1], [1, blob.scale]) },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.blob,
        {
          width: blob.size,
          height: blob.size,
          top: blob.top,
          bottom: blob.bottom,
          left: blob.left,
          right: blob.right,
          experimental_backgroundImage: [
            {
              type: "radial-gradient",
              shape: "circle",
              size: "farthest-side",
              position: { top: "50%", left: "50%" },
              colorStops: [
                { color: blob.color, positions: ["0%"] },
                { color: "transparent", positions: ["72%"] },
              ],
            },
          ],
        },
        animatedStyle,
      ]}
    />
  );
}

export function ScreenBackground({ children, style }: { children?: React.ReactNode; style?: ViewStyle }): React.JSX.Element {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.ground}>
      <View style={styles.blobField} pointerEvents="none">
        {BLOBS.map((blob, i) => (
          <BlobLayer key={i} blob={blob} />
        ))}
      </View>
      <View style={[styles.content, { paddingTop: insets.top, paddingBottom: insets.bottom }, style]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground },
  blobField: { ...StyleSheet.absoluteFill, opacity: BLOB_FIELD_OPACITY, overflow: "hidden" },
  blob: { position: "absolute", borderRadius: 9999 },
  content: { flex: 1 },
});
