import { Modal, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { Card } from "./Card";
import { GlassButton, type GlassButtonVariant } from "./GlassButton";
import { colors, type } from "../design/tokens";

interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant?: GlassButtonVariant;
  onConfirm: () => void;
  onCancel: () => void;
}

/** An in-app confirmation dialog matching the Argent glass design system --
 * replaces the OS-native `Alert.alert`, whose default styling reads as
 * inconsistent with the rest of the app (device-testing feedback). */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  confirmVariant = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel}>
      <Animated.View entering={FadeIn.duration(200)} style={styles.backdrop}>
        <Animated.View entering={FadeInDown.duration(250)} style={styles.cardWrap}>
          <Card style={styles.card}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.message}>{message}</Text>
            <View style={styles.actions}>
              <GlassButton label="Cancel" variant="ghost" onPress={onCancel} style={styles.button} />
              <GlassButton label={confirmLabel} variant={confirmVariant} onPress={onConfirm} style={styles.button} />
            </View>
          </Card>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.scrim, alignItems: "center", justifyContent: "center", padding: 24 },
  cardWrap: { width: "100%" },
  card: { gap: 12 },
  title: { fontFamily: type.screenTitle.family, fontSize: 18, color: colors.bone },
  message: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  actions: { flexDirection: "row", gap: 12, marginTop: 8 },
  button: { flex: 1 },
});
