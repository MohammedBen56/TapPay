import { isValidRib, parseMinorUnits } from "@tappay/shared";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as LocalAuthentication from "expo-local-authentication";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeInRight, FadeOutLeft } from "react-native-reanimated";
import { api } from "../../src/api/endpoints";
import { ApiError } from "../../src/api/client";
import { Card } from "../../src/components/Card";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { TextField } from "../../src/components/TextField";
import { colors, type } from "../../src/design/tokens";
import { formatMAD, formatRibGrouped } from "../../src/design/format";
import { decodeProfileQr } from "../../src/qr/profileQr";
import { readNfcProfile } from "../../src/nfc/nfcReader";
import { uuidv4 } from "../../src/util/uuid";

type Step = "recipient" | "amount" | "reference" | "review" | "success";
type RecipientMethod = "contacts" | "scan" | "type" | "import" | "nfc";

interface Recipient {
  rib: string;
  displayName: string;
  beneficiaryId?: string;
}

const STEP_TITLES: Record<Exclude<Step, "success">, string> = {
  recipient: "Send to",
  amount: "Amount",
  reference: "Reference",
  review: "Review & confirm",
};

export default function SendScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me });
  const [step, setStep] = useState<Step>("recipient");
  const [method, setMethod] = useState<RecipientMethod>("contacts");
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  const [ribInput, setRibInput] = useState("");
  const [ribLookupError, setRibLookupError] = useState<string | null>(null);
  const [ribLookupBusy, setRibLookupBusy] = useState(false);

  const [amountInput, setAmountInput] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);

  const [referenceInput, setReferenceInput] = useState("");

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [settledAmount, setSettledAmount] = useState<string | null>(null);
  const [settledTxUuid, setSettledTxUuid] = useState<string | null>(null);
  const [savingContact, setSavingContact] = useState(false);
  const [contactSaved, setContactSaved] = useState(false);

  const txUuidRef = useRef<string>(uuidv4());

  const resetFlow = useCallback(() => {
    setStep("recipient");
    setMethod("contacts");
    setRecipient(null);
    setRecipientError(null);
    setRibInput("");
    setRibLookupError(null);
    setAmountInput("");
    setAmountError(null);
    setReferenceInput("");
    setSubmitError(null);
    setSettledAmount(null);
    setSettledTxUuid(null);
    setContactSaved(false);
    txUuidRef.current = uuidv4();
  }, []);

  const goBack = useCallback((): void => {
    setStep((current) => {
      if (current === "amount") return "recipient";
      if (current === "reference") return "amount";
      if (current === "review") return "reference";
      return current;
    });
  }, []);

  // "Latest ref" pattern: hardwareBackPress's handler below is only
  // re-subscribed when `goBack`'s identity changes, not on every step
  // change, but needs the CURRENT step when it fires -- synced via effect
  // rather than a direct-render write, same pattern as AuthContext.tsx's
  // statusRef.
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  // Android hardware back / gesture nav: while mid-flow, step back through
  // the wizard instead of leaving the tab (the bottom-tabs navigator's
  // default back behavior jumps to the initial "Home" tab, which device
  // testing found jarring -- you lose your place in a half-filled send).
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (stepRef.current === "recipient") return false;
        goBack();
        return true;
      });
      return () => subscription.remove();
    }, [goBack]),
  );

  const chooseRecipient = (r: Recipient): void => {
    if (me && r.rib === me.rib) {
      setRecipientError("You can't send money to yourself.");
      return;
    }
    setRecipientError(null);
    setRecipient(r);
    setStep("amount");
  };

  const handleLookupRib = async (): Promise<void> => {
    const rib = ribInput.replace(/\s/g, "");
    if (!isValidRib(rib)) {
      setRibLookupError("That RIB doesn't look valid -- check the digits.");
      return;
    }
    setRibLookupBusy(true);
    setRibLookupError(null);
    try {
      const result = await api.lookupRib(rib);
      chooseRecipient({ rib: result.rib, displayName: result.display_name });
    } catch (err) {
      setRibLookupError(err instanceof ApiError && err.status === 404 ? "No account found with this RIB." : "Lookup failed -- try again.");
    } finally {
      setRibLookupBusy(false);
    }
  };

  const handleAmountContinue = (): void => {
    setAmountError(null);
    try {
      const minor = parseMinorUnits(amountInput);
      if (minor <= 0n) {
        setAmountError("Enter an amount greater than zero.");
        return;
      }
      setStep("reference");
    } catch {
      setAmountError("Enter a valid amount, e.g. 150.00");
    }
  };

  const handleConfirmSend = async (): Promise<void> => {
    if (!recipient) return;
    setSubmitError(null);

    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (hasHardware && isEnrolled) {
      const auth = await LocalAuthentication.authenticateAsync({ promptMessage: "Confirm to send money" });
      if (!auth.success) return;
    }

    setSubmitting(true);
    try {
      const amountMinor = parseMinorUnits(amountInput).toString();
      const result = await api.createTransfer({
        tx_uuid: txUuidRef.current,
        ...(recipient.beneficiaryId ? { to_beneficiary_id: recipient.beneficiaryId } : { to_rib: recipient.rib }),
        amount: amountMinor,
        currency: "MAD",
        reference: referenceInput.trim(),
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: ["balance"] });
      void queryClient.invalidateQueries({ queryKey: ["transactions"] });
      setSettledAmount(result.amount);
      setSettledTxUuid(result.tx_uuid);
      setStep("success");
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Couldn't send -- check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (step === "success") {
    return (
      <ScreenBackground style={styles.center}>
        <Animated.View entering={FadeIn.duration(400)} style={styles.successWrap}>
          <View style={styles.successIcon}>
            <Ionicons name="checkmark" size={36} color={colors.bone} />
          </View>
          <Text style={styles.successTitle}>Sent</Text>
          <Text style={styles.successAmount}>{settledAmount ? formatMAD(settledAmount) : ""} MAD</Text>
          <Text style={styles.successSubtext}>to {recipient?.displayName}</Text>
          {recipient && !recipient.beneficiaryId && (
            <GlassButton
              label={contactSaved ? "Saved to contacts" : "Save as contact"}
              variant="ghost"
              disabled={contactSaved}
              loading={savingContact}
              onPress={() => {
                setSavingContact(true);
                void api
                  .createBeneficiary({ display_name: recipient.displayName, rib: recipient.rib })
                  .then(() => {
                    setContactSaved(true);
                    void queryClient.invalidateQueries({ queryKey: ["beneficiaries"] });
                  })
                  .catch(() => {
                    // Duplicate or transient failure -- not worth blocking the success screen over.
                  })
                  .finally(() => setSavingContact(false));
              }}
              style={styles.successButton}
            />
          )}
          <GlassButton
            label="View receipt"
            variant="ghost"
            onPress={() => {
              const uuid = settledTxUuid;
              resetFlow();
              if (uuid) router.push({ pathname: "/transfer/[txUuid]", params: { txUuid: uuid } });
            }}
            style={styles.successButton}
          />
          <GlassButton
            label="Done"
            onPress={() => {
              resetFlow();
              router.replace("/(tabs)");
            }}
            style={styles.successButton}
          />
        </Animated.View>
      </ScreenBackground>
    );
  }

  return (
    <ScreenBackground>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <View style={styles.header}>
          {step !== "recipient" ? (
            <Pressable onPress={goBack} hitSlop={12} accessibilityRole="button">
              <Ionicons name="chevron-back" size={24} color={colors.bone} />
            </Pressable>
          ) : (
            <View style={styles.headerSpacer} />
          )}
          <Text style={styles.headerTitle}>{STEP_TITLES[step]}</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {step === "recipient" && (
            <View style={styles.gap16}>
              {recipientError ? <Text style={styles.errorBanner}>{recipientError}</Text> : null}
              <RecipientStep
                method={method}
                onMethodChange={setMethod}
                ribInput={ribInput}
                onRibInputChange={(text) => {
                  setRibInput(text);
                  setRibLookupError(null);
                }}
                ribLookupError={ribLookupError}
                ribLookupBusy={ribLookupBusy}
                onLookupRib={() => void handleLookupRib()}
                onChooseRecipient={chooseRecipient}
              />
            </View>
          )}

          {step === "amount" && recipient && (
            <Animated.View entering={FadeInRight.duration(250)} exiting={FadeOutLeft.duration(150)} style={styles.gap24}>
              <RecipientSummary recipient={recipient} />
              <View style={styles.amountInputWrap}>
                <TextField
                  label="Amount (MAD)"
                  value={amountInput}
                  onChangeText={(text) => {
                    setAmountInput(text);
                    setAmountError(null);
                  }}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  style={styles.amountField}
                  error={amountError}
                  autoFocus
                />
              </View>
              <GlassButton label="Continue" onPress={handleAmountContinue} disabled={!amountInput} />
            </Animated.View>
          )}

          {step === "reference" && recipient && (
            <Animated.View entering={FadeInRight.duration(250)} exiting={FadeOutLeft.duration(150)} style={styles.gap24}>
              <RecipientSummary recipient={recipient} />
              <Text style={styles.amountPreview}>{amountInput ? formatMAD(parseMinorUnits(amountInput).toString()) : ""} MAD</Text>
              <TextField
                label="Reference"
                value={referenceInput}
                onChangeText={setReferenceInput}
                placeholder="e.g. Rent, invoice #, dinner split"
                maxLength={140}
                autoFocus
              />
              <GlassButton label="Continue" onPress={() => setStep("review")} disabled={!referenceInput.trim()} />
            </Animated.View>
          )}

          {step === "review" && recipient && (
            <Animated.View entering={FadeInRight.duration(250)} exiting={FadeOutLeft.duration(150)} style={styles.gap24}>
              <Card style={styles.reviewCard}>
                <ReviewRow label="To" value={recipient.displayName} />
                <ReviewRow label="RIB" value={formatRibGrouped(recipient.rib)} />
                <ReviewRow label="Amount" value={`${formatMAD(parseMinorUnits(amountInput).toString())} MAD`} emphasize />
                <ReviewRow label="Reference" value={referenceInput.trim()} />
              </Card>
              {submitError ? <Text style={styles.errorBanner}>{submitError}</Text> : null}
              <GlassButton label="Confirm & send" onPress={() => void handleConfirmSend()} loading={submitting} />
            </Animated.View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenBackground>
  );
}

function ReviewRow({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }): React.JSX.Element {
  return (
    <View style={styles.reviewRow}>
      <Text style={styles.reviewLabel}>{label}</Text>
      <Text style={[styles.reviewValue, emphasize && styles.reviewValueEmphasized]}>{value}</Text>
    </View>
  );
}

function RecipientSummary({ recipient }: { recipient: Recipient }): React.JSX.Element {
  return (
    <View style={styles.recipientSummary}>
      <View style={styles.recipientAvatar}>
        <Text style={styles.recipientAvatarInitial}>{recipient.displayName.charAt(0).toUpperCase()}</Text>
      </View>
      <View>
        <Text style={styles.recipientName}>{recipient.displayName}</Text>
        <Text style={styles.recipientRib}>{formatRibGrouped(recipient.rib)}</Text>
      </View>
    </View>
  );
}

interface RecipientStepProps {
  method: RecipientMethod;
  onMethodChange: (m: RecipientMethod) => void;
  ribInput: string;
  onRibInputChange: (text: string) => void;
  ribLookupError: string | null;
  ribLookupBusy: boolean;
  onLookupRib: () => void;
  onChooseRecipient: (r: Recipient) => void;
}

function RecipientStep({
  method,
  onMethodChange,
  ribInput,
  onRibInputChange,
  ribLookupError,
  ribLookupBusy,
  onLookupRib,
  onChooseRecipient,
}: RecipientStepProps): React.JSX.Element {
  return (
    <View style={styles.gap24}>
      <SegmentedControl
        value={method}
        onChange={onMethodChange}
        options={[
          { value: "contacts", label: "Contacts" },
          { value: "scan", label: "Scan" },
          { value: "type", label: "RIB" },
          { value: "import", label: "Import" },
          { value: "nfc", label: "NFC" },
        ]}
      />

      {method === "contacts" && <ContactsList onChoose={onChooseRecipient} />}

      {method === "scan" && <ScanRecipient onChoose={onChooseRecipient} />}

      {method === "nfc" && <NfcRecipient onChoose={onChooseRecipient} />}

      {method === "type" && (
        <View style={styles.gap16}>
          <TextField
            label="Recipient RIB"
            value={ribInput}
            onChangeText={onRibInputChange}
            placeholder="999 xxxx xxxx xxxx xxxx xx"
            keyboardType="number-pad"
            maxLength={24}
            error={ribLookupError}
          />
          <GlassButton label="Look up" onPress={onLookupRib} loading={ribLookupBusy} disabled={ribInput.replace(/\s/g, "").length !== 24} />
        </View>
      )}

      {method === "import" && <ImportRecipient onChoose={onChooseRecipient} />}
    </View>
  );
}

function ContactsList({ onChoose }: { onChoose: (r: Recipient) => void }): React.JSX.Element {
  const { data, isLoading } = useQuery({ queryKey: ["beneficiaries"], queryFn: api.beneficiaries });
  const beneficiaries = data?.beneficiaries ?? [];

  if (isLoading) return <Text style={styles.mutedText}>Loading contacts…</Text>;
  if (beneficiaries.length === 0) {
    return <Text style={styles.mutedText}>No saved contacts yet. Try Scan, Type, or Import instead.</Text>;
  }

  return (
    <View style={styles.gap16}>
      {beneficiaries.map((b) => (
        <Pressable accessibilityRole="button"
          key={b.id}
          onPress={() => onChoose({ rib: b.rib, displayName: b.display_name, beneficiaryId: b.id })}
          style={({ pressed }) => [styles.contactRow, pressed && styles.pressed]}
        >
          <View style={styles.recipientAvatar}>
            <Text style={styles.recipientAvatarInitial}>{b.display_name.charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.flex1}>
            <Text style={styles.recipientName}>{b.display_name}</Text>
            <Text style={styles.recipientRib}>{formatRibGrouped(b.rib)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
        </Pressable>
      ))}
    </View>
  );
}

function ScanRecipient({ onChoose }: { onChoose: (r: Recipient) => void }): React.JSX.Element {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);

  const handleScanned = (result: { data: string }): void => {
    if (locked.current) return;
    const payload = decodeProfileQr(result.data);
    if (!payload || !isValidRib(payload.rib)) {
      setError("That QR code isn't a TapPay profile code.");
      return;
    }
    locked.current = true;
    void Haptics.selectionAsync();
    onChoose({ rib: payload.rib, displayName: payload.display_name || "Recipient" });
  };

  if (!permission) return <Text style={styles.mutedText}>Checking camera permission…</Text>;
  if (!permission.granted) {
    return (
      <View style={styles.gap16}>
        <Text style={styles.mutedText}>TapPay needs camera access to scan a QR code.</Text>
        <GlassButton label="Grant camera access" onPress={() => void requestPermission()} />
      </View>
    );
  }

  return (
    <View style={styles.gap16}>
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={handleScanned}
        />
      </View>
      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}
    </View>
  );
}

// Note: if this unmounts (user switches methods, leaves the screen) while a
// read is in flight, readNfcProfile's own 30s timeout + internal
// cancelTechnologyRequest() still tear the reader session down -- this just
// stops acting on the result, it doesn't cut the wait short. Acceptable for
// now since Send is the only reader-role screen; worth a real abort signal
// if that stops being true.
function NfcRecipient({ onChoose }: { onChoose: (r: Recipient) => void }): React.JSX.Element {
  const [status, setStatus] = useState<"waiting" | "error">("waiting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Standard reset-then-fetch pattern: `attempt` changing (the retry
    // button) is what should re-arm "waiting", there's no way to derive
    // that during render instead.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus("waiting");
    setError(null);

    void readNfcProfile(30_000).then((outcome) => {
      if (cancelled) return;
      switch (outcome.status) {
        case "success":
          void Haptics.selectionAsync();
          onChoose({ rib: outcome.payload.rib, displayName: outcome.payload.display_name || "Recipient" });
          return;
        case "cancelled":
          setStatus("error");
          setError("No phone detected -- try again.");
          return;
        case "not_a_tappay_tag":
          setStatus("error");
          setError("That's not a TapPay phone sharing over NFC.");
          return;
        case "no_payload":
          setStatus("error");
          setError("The other phone isn't sharing right now -- ask them to tap \"Share via NFC\" on their Profile.");
          return;
        case "invalid_payload":
          setStatus("error");
          setError("Couldn't read that phone's account info -- try again.");
          return;
        case "error":
          setStatus("error");
          setError(outcome.message);
          return;
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  return (
    <View style={styles.gap16}>
      <View style={styles.nfcWaitBox}>
        <MaterialIcons name="nfc" size={48} color={status === "waiting" ? colors.bone : colors.textTertiary} />
        <Text style={styles.mutedText}>{status === "waiting" ? "Hold phones together" : "Not detected"}</Text>
      </View>
      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}
      {status === "error" && <GlassButton label="Try again" variant="ghost" onPress={() => setAttempt((n) => n + 1)} />}
    </View>
  );
}

function ImportRecipient({ onChoose }: { onChoose: (r: Recipient) => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = async (): Promise<void> => {
    setError(null);
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false });
    if (result.canceled || !result.assets[0]) return;
    setBusy(true);
    try {
      const { scanFromURLAsync } = await import("expo-camera");
      const matches = await scanFromURLAsync(result.assets[0].uri, ["qr"]);
      const payload = matches[0] ? decodeProfileQr(matches[0].data) : null;
      if (!payload || !isValidRib(payload.rib)) {
        setError("No TapPay QR code found in that photo.");
        return;
      }
      onChoose({ rib: payload.rib, displayName: payload.display_name || "Recipient" });
    } catch {
      setError("Couldn't read that photo -- try another one.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.gap16}>
      <Text style={styles.mutedText}>Choose a photo containing a TapPay profile QR code.</Text>
      <GlassButton label="Choose photo" onPress={() => void handlePick()} loading={busy} />
      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flex1: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", padding: 24 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 8 },
  headerSpacer: { width: 24 },
  headerTitle: { fontFamily: type.screenTitle.family, fontSize: 18, color: colors.bone },
  scroll: { flexGrow: 1, padding: 20, gap: 24 },
  gap24: { gap: 24 },
  gap16: { gap: 16 },
  mutedText: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  errorBanner: { fontFamily: type.caption.family, fontSize: 13, color: colors.danger },
  pressed: { opacity: 0.6 },
  contactRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  recipientAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.glassHigh,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  recipientAvatarInitial: { fontFamily: type.bodyStrong.family, fontSize: 17, color: colors.bone },
  recipientSummary: { flexDirection: "row", alignItems: "center", gap: 12 },
  recipientName: { fontFamily: type.bodyStrong.family, fontSize: 16, color: colors.bone },
  recipientRib: { fontFamily: type.caption.family, fontSize: 12, color: colors.textTertiary, marginTop: 2 },
  cameraWrap: { aspectRatio: 1, borderRadius: 20, overflow: "hidden", backgroundColor: colors.sunken, borderWidth: 1, borderColor: colors.glassBorder },
  nfcWaitBox: {
    aspectRatio: 1.6,
    borderRadius: 20,
    backgroundColor: colors.sunken,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  amountInputWrap: { alignItems: "center" },
  amountField: { fontFamily: type.hero.family, fontSize: 36, textAlign: "center", height: 72 },
  amountPreview: { fontFamily: type.hero.family, fontSize: 36, color: colors.bone, textAlign: "center" },
  reviewCard: { gap: 16 },
  reviewRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  reviewLabel: { fontFamily: type.caption.family, fontSize: 13, color: colors.textSecondary },
  reviewValue: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone, maxWidth: "60%", textAlign: "right" },
  reviewValueEmphasized: { fontFamily: type.amount.family, fontSize: 20, color: colors.bone },
  successWrap: { alignItems: "center", gap: 8, width: "100%" },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.creditTint,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  successTitle: { fontFamily: type.screenTitle.family, fontSize: 22, color: colors.bone },
  successAmount: { fontFamily: type.hero.family, fontSize: 38, color: colors.bone, marginTop: 4 },
  successSubtext: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, marginBottom: 16 },
  successButton: { width: "100%", marginTop: 8 },
});
