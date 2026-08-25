import { parseMinorUnits } from "@tappay/shared";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { api } from "../../src/api/endpoints";
import { ApiError } from "../../src/api/client";
import { Card } from "../../src/components/Card";
import { ConfirmDialog } from "../../src/components/ConfirmDialog";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { TextField } from "../../src/components/TextField";
import { colors, radius, type } from "../../src/design/tokens";
import { formatLongDate, formatMAD } from "../../src/design/format";

interface GoalRowProps {
  goal: { id: string; name: string; target_amount: string; saved_amount: string; target_date: string | null };
  onFund: (id: string, amountMinor: string) => Promise<void>;
  onDelete: (id: string) => void;
}

function GoalRow({ goal, onFund, onDelete }: GoalRowProps): React.JSX.Element {
  const [funding, setFunding] = useState(false);
  const [fundInput, setFundInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = BigInt(goal.target_amount);
  const saved = BigInt(goal.saved_amount);
  const progress = target > 0n ? Math.min(1, Number(saved) / Number(target)) : 0;

  const handleFund = async (): Promise<void> => {
    setError(null);
    let amountMinor: bigint;
    try {
      amountMinor = parseMinorUnits(fundInput);
      if (amountMinor <= 0n) throw new Error("must be positive");
    } catch {
      setError("Enter a valid amount, e.g. 150.00");
      return;
    }
    setBusy(true);
    try {
      await onFund(goal.id, amountMinor.toString());
      setFunding(false);
      setFundInput("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add funds — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={styles.goalCard}>
      <View style={styles.goalHeader}>
        <Text style={styles.goalName}>{goal.name}</Text>
        <Pressable
          onPress={() => onDelete(goal.id)}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Delete goal"
          accessibilityHint={`Deletes the ${goal.name} goal`}
        >
          <Ionicons name="trash-outline" size={18} color={colors.textTertiary} />
        </Pressable>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>
      <View style={styles.goalMetaRow}>
        <Text style={styles.goalAmount}>
          {formatMAD(goal.saved_amount)} <Text style={styles.goalTarget}>of {formatMAD(goal.target_amount)} MAD</Text>
        </Text>
        {goal.target_date ? <Text style={styles.goalDate}>by {formatLongDate(goal.target_date)}</Text> : null}
      </View>
      {funding ? (
        <View style={styles.fundRow}>
          <TextField
            label="Add funds"
            value={fundInput}
            onChangeText={setFundInput}
            placeholder="0.00"
            keyboardType="decimal-pad"
            autoFocus
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.fundActions}>
            <GlassButton label="Cancel" variant="ghost" onPress={() => setFunding(false)} style={styles.fundButton} />
            <GlassButton label="Add" onPress={() => void handleFund()} loading={busy} style={styles.fundButton} />
          </View>
        </View>
      ) : (
        <GlassButton label="Add funds" variant="ghost" onPress={() => setFunding(true)} style={styles.addFundsButton} />
      )}
    </Card>
  );
}

/** Ship List v2 Wave 2 Phase 5: financial goals/vaults. A goal earmarks an
 * amount inside the customer's one real savings account — funding is a
 * pure bookkeeping increment (server/routes/goals.ts), no money movement,
 * since the money already sits in savings. */
export default function GoalsScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const goalsQuery = useQuery({ queryKey: ["goals"], queryFn: api.goals });

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);

  const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ["goals"] }).then(() => undefined);

  const handleCreate = async (): Promise<void> => {
    setCreateError(null);
    let targetMinor: bigint;
    try {
      targetMinor = parseMinorUnits(targetInput);
      if (targetMinor <= 0n) throw new Error("must be positive");
    } catch {
      setCreateError("Enter a valid target amount, e.g. 5000.00");
      return;
    }
    if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      setCreateError("Target date must be YYYY-MM-DD, or left blank");
      return;
    }
    setCreateBusy(true);
    try {
      await api.createGoal({ name: name.trim(), target_amount: targetMinor.toString(), target_date: targetDate || undefined });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setName("");
      setTargetInput("");
      setTargetDate("");
      setCreating(false);
      await invalidate();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't create goal — try again.");
    } finally {
      setCreateBusy(false);
    }
  };

  const handleFund = async (id: string, amountMinor: string): Promise<void> => {
    await api.fundGoal(id, { amount: amountMinor });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await invalidate();
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteCandidate) return;
    await api.deleteGoal(deleteCandidate);
    setDeleteCandidate(null);
    await invalidate();
  };

  const goals = goalsQuery.data?.goals ?? [];

  return (
    <ScreenBackground>
      <ScrollView contentContainerStyle={styles.scroll}>
        {goals.length === 0 && !creating ? (
          <Text style={styles.emptyText}>No goals yet. Start one to track savings toward something specific.</Text>
        ) : null}

        <Animated.View entering={FadeIn.duration(200)} style={styles.gap16}>
          {goals.map((goal) => (
            <GoalRow key={goal.id} goal={goal} onFund={handleFund} onDelete={setDeleteCandidate} />
          ))}
        </Animated.View>

        {creating ? (
          <Card style={styles.createCard}>
            <TextField label="Goal name" value={name} onChangeText={setName} placeholder="e.g. Trip to Fes" autoFocus />
            <TextField label="Target amount" value={targetInput} onChangeText={setTargetInput} placeholder="5000.00" keyboardType="decimal-pad" />
            <TextField label="Target date (optional)" value={targetDate} onChangeText={setTargetDate} placeholder="YYYY-MM-DD" />
            {createError ? <Text style={styles.errorText}>{createError}</Text> : null}
            <View style={styles.fundActions}>
              <GlassButton label="Cancel" variant="ghost" onPress={() => setCreating(false)} style={styles.fundButton} />
              <GlassButton label="Create" onPress={() => void handleCreate()} loading={createBusy} disabled={!name.trim() || !targetInput} style={styles.fundButton} />
            </View>
          </Card>
        ) : (
          <GlassButton label="New goal" onPress={() => setCreating(true)} />
        )}
      </ScrollView>
      <ConfirmDialog
        visible={deleteCandidate !== null}
        title="Delete this goal?"
        message="This only removes the tracking record — any money already swept into savings stays there."
        confirmLabel="Delete"
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteCandidate(null)}
      />
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 20, paddingBottom: 60 },
  gap16: { gap: 16 },
  emptyText: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, lineHeight: 20, textAlign: "center", paddingVertical: 20 },
  goalCard: { gap: 12 },
  goalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  goalName: { fontFamily: type.bodyStrong.family, fontSize: 16, color: colors.bone },
  progressTrack: { height: 8, borderRadius: radius.pill, backgroundColor: colors.glassLow, overflow: "hidden" },
  progressFill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.creditTint },
  goalMetaRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  goalAmount: { fontFamily: type.bodyStrong.family, fontSize: 14, color: colors.bone },
  goalTarget: { fontFamily: type.body.family, color: colors.textSecondary },
  goalDate: { fontFamily: type.caption.family, fontSize: 12, color: colors.textTertiary },
  addFundsButton: { alignSelf: "flex-start" },
  fundRow: { gap: 12 },
  fundActions: { flexDirection: "row", gap: 12 },
  fundButton: { flex: 1 },
  createCard: { gap: 16 },
  errorText: { fontFamily: type.caption.family, fontSize: 13, color: colors.danger },
});
