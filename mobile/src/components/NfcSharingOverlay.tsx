import { MaterialIcons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { Card } from "./Card";
import { GlassButton } from "./GlassButton";
import { colors, type } from "../design/tokens";

/** Full-screen "hold phones together" prompt shown while NFC sharing is
 * active. Extracted from profile.tsx (Ship List v2 Wave 3 self-review):
 * requests/index.tsx's OutgoingRow fired startNfcSharing() with zero visual
 * feedback -- a real UX-quality gap between the two screens that ship the
 * same feature. Both call sites now render the same overlay. */
export function NfcSharingOverlay({ body, onDone }: { body: string; onDone: () => void }): React.JSX.Element {
  return (
    <Animated.View entering={FadeIn.duration(200)} style={styles.overlay}>
      <Animated.View entering={FadeInDown.duration(250)} style={styles.cardWrap}>
        <Card style={styles.card}>
          <View style={styles.icon}>
            <MaterialIcons name="nfc" size={32} color={colors.bone} />
          </View>
          <Text style={styles.title}>Hold phones together</Text>
          <Text style={styles.body}>{body}</Text>
          <GlassButton label="Done" onPress={onDone} style={styles.doneButton} />
        </Card>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.scrim,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  cardWrap: { width: "100%" },
  card: { alignItems: "center", gap: 12, padding: 28 },
  icon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.glassHigh,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: { fontFamily: type.screenTitle.family, fontSize: 20, color: colors.bone, textAlign: "center" },
  body: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, textAlign: "center", lineHeight: 20 },
  doneButton: { width: "100%", marginTop: 8 },
});
