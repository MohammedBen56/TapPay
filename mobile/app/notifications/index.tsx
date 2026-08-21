import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { Notification } from "@tappay/shared";
import { api } from "../../src/api/endpoints";
import { Card } from "../../src/components/Card";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { colors, type } from "../../src/design/tokens";
import { formatShortDate } from "../../src/design/format";

function NotificationRow({ notification, onPress }: { notification: Notification; onPress: () => void }): React.JSX.Element {
  const unread = notification.read_at === null;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.rowPressable, pressed && styles.pressed]}>
      <Card style={styles.row}>
        <View style={styles.rowTop}>
          {unread ? <View style={styles.unreadDot} /> : null}
          <Text style={[styles.title, !unread && styles.titleRead]}>{notification.title}</Text>
          <Text style={styles.date}>{formatShortDate(notification.created_at)}</Text>
        </View>
        <Text style={styles.body}>{notification.body}</Text>
      </Card>
    </Pressable>
  );
}

/** Ship List v2 Wave 2 Phase 8: the in-app notification center -- what
 * makes push notifications usable and demoable regardless of whether live
 * push delivery works on any given device (server/src/notifications.ts's
 * own header comment has the real EAS-project-id boundary on that). No
 * live-updating/socket here -- a pull-to-refresh list, same as every
 * other list screen in this app before push existed to make anything
 * feel real-time. */
export default function NotificationsScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["notifications"], queryFn: api.notifications, staleTime: 15_000 });
  const notifications = query.data?.notifications ?? [];

  const handlePress = async (notification: Notification): Promise<void> => {
    const data = notification.data as { type?: string; request_id?: string } | null;
    if (notification.read_at === null) {
      await api.markNotificationRead(notification.id);
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    }
    if (data?.type === "money_request" || data?.type === "money_request_fulfilled") {
      router.push("/requests");
    }
  };

  return (
    <ScreenBackground>
      <ScrollView contentContainerStyle={styles.scroll}>
        {notifications.length === 0 ? (
          <Text style={styles.emptyText}>Nothing yet.</Text>
        ) : (
          <Animated.View entering={FadeIn.duration(200)} style={styles.gap12}>
            {notifications.map((n) => (
              <NotificationRow key={n.id} notification={n} onPress={() => void handlePress(n)} />
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
  emptyText: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, textAlign: "center", paddingVertical: 20 },
  rowPressable: {},
  pressed: { opacity: 0.7 },
  row: { gap: 6 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.creditTint },
  title: { flex: 1, fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone },
  titleRead: { color: colors.textSecondary },
  date: { fontFamily: type.caption.family, fontSize: 12, color: colors.textTertiary },
  body: { fontFamily: type.body.family, fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
});
