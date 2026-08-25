import { isValidRib, parseMinorUnits } from "@tappay/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { api } from "../../src/api/endpoints";
import { ApiError } from "../../src/api/client";
import { Card } from "../../src/components/Card";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { TextField } from "../../src/components/TextField";
import { colors, type } from "../../src/design/tokens";
import { formatRibGrouped } from "../../src/design/format";

interface Recipient {
  rib: string;
  displayName: string;
  beneficiaryId?: string;
}

/** Ship List v2 Wave 2 Phase 7: creates a targeted money request — same
 * recipient-resolution shape as Send (contacts or a typed RIB), reused
 * deliberately rather than a QR-scan-to-pick-target flow, since a
 * request names a specific person by construction (server/routes/
 * moneyRequests.ts's own doc comment). */
export default function NewMoneyRequestScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<"contacts" | "type">("contacts");
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [ribInput, setRibInput] = useState("");
  const [ribError, setRibError] = useState<string | null>(null);
  const [ribBusy, setRibBusy] = useState(false);

  const [amountInput, setAmountInput] = useState("");
  const [referenceInput, setReferenceInput] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const beneficiariesQuery = useQuery({ queryKey: ["beneficiaries"], queryFn: api.beneficiaries });

  const handleLookupRib = async (): Promise<void> => {
    const rib = ribInput.replace(/\s/g, "");
    if (!isValidRib(rib)) {
      setRibError("That RIB doesn't look valid — check the digits.");
      return;
    }
    setRibBusy(true);
    setRibError(null);
    try {
      const result = await api.lookupRib(rib);
      setRecipient({ rib: result.rib, displayName: result.display_name });
    } catch (err) {
      setRibError(err instanceof ApiError && err.status === 404 ? "No account found with this RIB." : "Lookup failed — try again.");
    } finally {
      setRibBusy(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (!recipient) return;
    setSubmitError(null);
    let amountMinor: bigint;
    try {
      amountMinor = parseMinorUnits(amountInput);
      if (amountMinor <= 0n) throw new Error("must be positive");
    } catch {
      setSubmitError("Enter a valid amount, e.g. 150.00");
      return;
    }
    setSubmitting(true);
    try {
      await api.createMoneyRequest({
        ...(recipient.beneficiaryId ? { to_beneficiary_id: recipient.beneficiaryId } : { to_rib: recipient.rib }),
        amount: amountMinor.toString(),
        currency: "MAD",
        reference: referenceInput.trim(),
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: ["money-requests"] });
      router.replace("/requests");
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSubmitError(err instanceof ApiError ? err.message : "Couldn't send this request — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = Boolean(recipient) && Boolean(amountInput) && Boolean(referenceInput.trim());

  return (
    <ScreenBackground>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.sectionLabel}>Request from</Text>
        {recipient ? (
          <Card style={styles.recipientCard}>
            <View style={styles.recipientRow}>
              <View style={styles.recipientAvatar}>
                <Text style={styles.recipientAvatarInitial} maxFontSizeMultiplier={1.3}>
                  {recipient.displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
              <View>
                <Text style={styles.recipientName}>{recipient.displayName}</Text>
                <Text style={styles.recipientRib}>{formatRibGrouped(recipient.rib)}</Text>
              </View>
            </View>
            <GlassButton label="Change" variant="ghost" onPress={() => setRecipient(null)} style={styles.changeButton} />
          </Card>
        ) : (
          <Animated.View entering={FadeIn.duration(200)} style={styles.gap16}>
            <SegmentedControl
              options={[
                { value: "contacts", label: "Contacts" },
                { value: "type", label: "Type RIB" },
              ]}
              value={method}
              onChange={setMethod}
            />
            {method === "contacts" ? (
              <FlatList
                data={beneficiariesQuery.data?.beneficiaries ?? []}
                keyExtractor={(b) => b.id}
                scrollEnabled={false}
                ListEmptyComponent={<Text style={styles.emptyText}>No saved contacts yet.</Text>}
                renderItem={({ item }) => (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setRecipient({ rib: item.rib, displayName: item.display_name, beneficiaryId: item.id })}
                    style={({ pressed }) => [styles.contactRow, pressed && styles.pressed]}
                  >
                    <View style={styles.recipientAvatar}>
                      <Text style={styles.recipientAvatarInitial} maxFontSizeMultiplier={1.3}>
                        {item.display_name.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.recipientName}>{item.display_name}</Text>
                  </Pressable>
                )}
              />
            ) : (
              <View style={styles.gap16}>
                <TextField label="RIB" value={ribInput} onChangeText={setRibInput} placeholder="230780000001234567890123" autoCapitalize="none" />
                {ribError ? <Text style={styles.errorText}>{ribError}</Text> : null}
                <GlassButton label="Look up" variant="ghost" onPress={() => void handleLookupRib()} loading={ribBusy} disabled={!ribInput} />
              </View>
            )}
          </Animated.View>
        )}

        {recipient ? (
          <>
            <TextField label="Amount" value={amountInput} onChangeText={setAmountInput} placeholder="0.00" keyboardType="decimal-pad" />
            <TextField label="Reference" value={referenceInput} onChangeText={setReferenceInput} placeholder="e.g. Dinner split" maxLength={140} />
            {submitError ? <Text style={styles.errorText}>{submitError}</Text> : null}
            <GlassButton label="Request money" onPress={() => void handleSubmit()} loading={submitting} disabled={!canSubmit} />
          </>
        ) : null}
      </ScrollView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 20, paddingBottom: 60 },
  gap16: { gap: 16 },
  sectionLabel: {
    fontFamily: type.sectionLabel.family,
    fontSize: type.sectionLabel.size,
    letterSpacing: type.sectionLabel.letterSpacing,
    color: colors.textQuiet,
    textTransform: "uppercase",
  },
  recipientCard: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  recipientRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  recipientAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.glassLow, alignItems: "center", justifyContent: "center" },
  recipientAvatarInitial: { fontFamily: type.bodyStrong.family, fontSize: 16, color: colors.bone },
  recipientName: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone },
  recipientRib: { fontFamily: type.caption.family, fontSize: 12, color: colors.textTertiary },
  changeButton: { paddingHorizontal: 16 },
  contactRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  pressed: { opacity: 0.6 },
  emptyText: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, textAlign: "center", paddingVertical: 20 },
  errorText: { fontFamily: type.caption.family, fontSize: 13, color: colors.danger },
});
