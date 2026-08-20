import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { api } from "../../src/api/endpoints";
import { Card } from "../../src/components/Card";
import { ConfirmDialog } from "../../src/components/ConfirmDialog";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { colors, type } from "../../src/design/tokens";
import { formatDateTime } from "../../src/design/format";

/** Ship List v2. There's no reliable way to mark "this device" -- the
 * access token carries no session/family id (see refreshTokens.ts's own
 * comment on why change-password doesn't try to spare the calling
 * session either) -- so every active session lists the same way. Revoking
 * one that happens to be the current device is handled gracefully by
 * AuthContext's session-expired handler (tokenStore.ts), not specially
 * here. */
export default function SessionsScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery({ queryKey: ["auth-sessions"], queryFn: api.sessions });
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const handleRevoke = async (id: string): Promise<void> => {
    setConfirmingId(null);
    setRevoking(id);
    try {
      await api.revokeSession(id);
      await queryClient.invalidateQueries({ queryKey: ["auth-sessions"] });
    } finally {
      setRevoking(null);
    }
  };

  const sessions = sessionsQuery.data?.sessions ?? [];

  return (
    <ScreenBackground>
      <View style={styles.container}>
        <Text style={styles.intro}>Every device currently signed in to your account. Revoking one signs it out immediately.</Text>
        <FlatList
          data={sessions}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          renderItem={({ item }) => (
            <Card style={styles.sessionCard}>
              <View style={styles.sessionIcon}>
                <Ionicons name="phone-portrait-outline" size={18} color={colors.bone} />
              </View>
              <View style={styles.sessionMiddle}>
                <Text style={styles.sessionTitle}>Active session</Text>
                <Text style={styles.sessionMeta}>Signed in {formatDateTime(item.issued_at)}</Text>
              </View>
              <GlassButton
                label="Revoke"
                variant="danger"
                loading={revoking === item.id}
                onPress={() => setConfirmingId(item.id)}
                style={styles.revokeButton}
              />
            </Card>
          )}
          ListEmptyComponent={
            sessionsQuery.isLoading ? (
              <Text style={styles.emptyText}>Loading…</Text>
            ) : (
              <Text style={styles.emptyText}>No active sessions.</Text>
            )
          }
        />
      </View>

      <ConfirmDialog
        visible={confirmingId !== null}
        title="Revoke this session?"
        message="That device will be signed out immediately and will need to sign in again."
        confirmLabel="Revoke"
        onCancel={() => setConfirmingId(null)}
        onConfirm={() => {
          if (confirmingId) void handleRevoke(confirmingId);
        }}
      />
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 20, gap: 16 },
  intro: { fontFamily: type.caption.family, fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
  listContent: { paddingBottom: 40 },
  separator: { height: 10 },
  sessionCard: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
  sessionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.glassLow,
  },
  sessionMiddle: { flex: 1, gap: 2 },
  sessionTitle: { fontFamily: type.bodyStrong.family, fontSize: 14, color: colors.bone },
  sessionMeta: { fontFamily: type.caption.family, fontSize: 12, color: colors.textQuiet },
  revokeButton: { paddingHorizontal: 4 },
  emptyText: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, textAlign: "center", paddingTop: 40 },
});
