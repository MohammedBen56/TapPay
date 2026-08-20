import type { BillerCategory } from "@tappay/shared";
import { parseMinorUnits } from "@tappay/shared";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeInRight, FadeOutLeft } from "react-native-reanimated";
import { ApiError } from "../../src/api/client";
import { api } from "../../src/api/endpoints";
import { useBiometricConfirm } from "../../src/auth/useBiometricConfirm";
import { Card } from "../../src/components/Card";
import { GlassButton } from "../../src/components/GlassButton";
import { ReviewRow } from "../../src/components/ReviewRow";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { TextField } from "../../src/components/TextField";
import { BILLER_CATEGORY_ICON, BILLER_CATEGORY_LABEL } from "../../src/design/billerCategory";
import { colors, type } from "../../src/design/tokens";
import { formatMAD } from "../../src/design/format";
import { uuidv4 } from "../../src/util/uuid";

type Step = "details" | "review";

export default function PayBillScreen(): React.JSX.Element {
  const { billerId, name, category } = useLocalSearchParams<{ billerId: string; name: string; category: BillerCategory }>();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("details");
  const [subscriberReference, setSubscriberReference] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [txUuid] = useState(() => uuidv4());
  const confirmBiometric = useBiometricConfirm();

  // Same reasoning and pattern as send.tsx: while on the review step,
  // Android hardware back/gesture nav should step back to "details"
  // instead of exiting the flow and silently discarding what was entered
  // -- the "Back" ghost button below already does this, hardware back
  // previously didn't.
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (stepRef.current === "details") return false;
        setStep("details");
        return true;
      });
      return () => subscription.remove();
    }, []),
  );

  const handleContinue = (): void => {
    setAmountError(null);
    try {
      const minor = parseMinorUnits(amountInput);
      if (minor <= 0n) {
        setAmountError("Enter an amount greater than zero.");
        return;
      }
      setStep("review");
    } catch {
      setAmountError("Enter a valid amount, e.g. 150.00");
    }
  };

  const handleConfirmPay = async (): Promise<void> => {
    setSubmitError(null);

    if (!(await confirmBiometric("Confirm to pay this bill"))) return;

    setSubmitting(true);
    try {
      const result = await api.payBill({
        tx_uuid: txUuid,
        biller_id: billerId,
        subscriber_reference: subscriberReference.trim(),
        amount: parseMinorUnits(amountInput).toString(),
        currency: "MAD",
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: ["balance"] });
      void queryClient.invalidateQueries({ queryKey: ["transactions"] });
      router.replace({ pathname: "/transfer/[txUuid]", params: { txUuid: result.tx_uuid } });
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Couldn't pay -- check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScreenBackground>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.billerHeader}>
            <View style={styles.iconWrap}>
              <Ionicons name={BILLER_CATEGORY_ICON[category]} size={26} color={colors.bone} />
            </View>
            <View>
              <Text style={styles.billerName}>{name}</Text>
              <Text style={styles.billerCategory}>{BILLER_CATEGORY_LABEL[category]}</Text>
            </View>
          </View>

          {step === "details" && (
            <Animated.View entering={FadeInRight.duration(250)} exiting={FadeOutLeft.duration(150)} style={styles.gap24}>
              <TextField
                label="Contract / subscriber number"
                value={subscriberReference}
                onChangeText={setSubscriberReference}
                placeholder="e.g. 445566"
                autoFocus
              />
              <TextField
                label="Amount (MAD)"
                value={amountInput}
                onChangeText={(text) => {
                  setAmountInput(text);
                  setAmountError(null);
                }}
                keyboardType="decimal-pad"
                placeholder="0.00"
                error={amountError}
              />
              <GlassButton label="Continue" onPress={handleContinue} disabled={!subscriberReference.trim() || !amountInput} />
            </Animated.View>
          )}

          {step === "review" && (
            <Animated.View entering={FadeInRight.duration(250)} exiting={FadeOutLeft.duration(150)} style={styles.gap24}>
              <Card style={styles.reviewCard}>
                <ReviewRow label="Biller" value={name} />
                <ReviewRow label="Contract / subscriber #" value={subscriberReference.trim()} />
                <ReviewRow label="Amount" value={`${formatMAD(parseMinorUnits(amountInput).toString())} MAD`} emphasize />
              </Card>
              {submitError ? <Text style={styles.errorBanner}>{submitError}</Text> : null}
              <GlassButton label="Confirm & pay" onPress={() => void handleConfirmPay()} loading={submitting} />
              <GlassButton label="Back" variant="ghost" onPress={() => setStep("details")} disabled={submitting} />
            </Animated.View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { padding: 20, gap: 24, paddingBottom: 80 },
  billerHeader: { flexDirection: "row", alignItems: "center", gap: 14 },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.glassLow,
  },
  billerName: { fontFamily: type.bodyStrong.family, fontSize: 17, color: colors.bone },
  billerCategory: { fontFamily: type.caption.family, fontSize: 12, color: colors.textQuiet, marginTop: 2 },
  gap24: { gap: 24 },
  reviewCard: { gap: 4 },
  errorBanner: { fontFamily: type.caption.family, fontSize: 13, color: colors.danger },
});
