import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { api } from "../../src/api/endpoints";
import { ApiError } from "../../src/api/client";
import { Card } from "../../src/components/Card";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { TextField } from "../../src/components/TextField";
import { colors, type } from "../../src/design/tokens";

const FAQ: { question: string; answer: string }[] = [
  {
    question: "Is TapPay a real bank?",
    answer:
      "No -- TapPay is a demo product. It moves no real funds and is not a licensed bank. Every balance and transaction here is simulated.",
  },
  {
    question: "How does biometric sign-in work?",
    answer:
      "Your fingerprint or face unlock protects a securely stored login token on this device -- it never leaves the device, and your password is never cached alongside it.",
  },
  {
    question: "What does round-up savings do?",
    answer:
      "When it's on, sending money rounds the amount up to the next whole MAD and moves the difference into your savings account automatically, right after the send settles.",
  },
  {
    question: "Why did a large transfer ask me for my password again?",
    answer:
      "Amounts over a certain threshold need a fresh password confirmation as an extra safeguard, on top of the fingerprint/face confirmation every send already asks for.",
  },
  {
    question: "What happens when I flag a transaction?",
    answer:
      "It's recorded for review -- flagging never reverses or holds the money itself, since there's no dispute/chargeback mechanism here. Use the contact form below if you need a faster response.",
  },
];

function FaqRow({ question, answer }: { question: string; answer: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => {
        void Haptics.selectionAsync();
        setOpen((o) => !o);
      }}
      style={styles.faqRow}
    >
      <View style={styles.faqHeader}>
        <Text style={styles.faqQuestion}>{question}</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.textTertiary} />
      </View>
      {open ? (
        <Animated.View entering={FadeIn.duration(150)}>
          <Text style={styles.faqAnswer}>{answer}</Text>
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

/** Ship List v2 Wave 2 Phase 6: in-app support/FAQ. A real, stored
 * contact-form submission (server/routes/support.ts), not a mailto: --
 * gives the caller a record of their own past requests and a real audit
 * trail, reviewed directly by the (single) operator per
 * docs/INCIDENT_RESPONSE.md's stated reality. */
export default function HelpScreen(): React.JSX.Element {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleSend = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api.createSupportRequest({ subject: subject.trim(), message: message.trim() });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSubject("");
      setMessage("");
      setSent(true);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof ApiError ? err.message : "Couldn't send your message -- check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenBackground>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.sectionLabel}>Frequently asked</Text>
        <Card style={styles.faqCard}>
          {FAQ.map((item, i) => (
            <View key={item.question}>
              {i > 0 ? <View style={styles.divider} /> : null}
              <FaqRow question={item.question} answer={item.answer} />
            </View>
          ))}
        </Card>

        <Text style={styles.sectionLabel}>Contact us</Text>
        <Card style={styles.formCard}>
          {sent ? (
            <Text style={styles.sentText}>Sent. You can see your past requests here anytime you come back.</Text>
          ) : (
            <>
              <TextField label="Subject" value={subject} onChangeText={setSubject} placeholder="What's this about?" />
              <TextField
                label="Message"
                value={message}
                onChangeText={setMessage}
                placeholder="Tell us more"
                multiline
                numberOfLines={4}
                style={styles.messageField}
              />
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
              <GlassButton label="Send" onPress={() => void handleSend()} loading={busy} disabled={!subject.trim() || !message.trim()} />
            </>
          )}
        </Card>
      </ScrollView>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 20, paddingBottom: 60 },
  sectionLabel: {
    fontFamily: type.sectionLabel.family,
    fontSize: type.sectionLabel.size,
    letterSpacing: type.sectionLabel.letterSpacing,
    color: colors.textQuiet,
    textTransform: "uppercase",
    marginBottom: -8,
  },
  faqCard: { gap: 0, padding: 8 },
  faqRow: { paddingVertical: 12, paddingHorizontal: 8, gap: 8 },
  faqHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  faqQuestion: { flex: 1, fontFamily: type.bodyStrong.family, fontSize: 14, color: colors.bone },
  faqAnswer: { fontFamily: type.body.family, fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
  divider: { height: 1, backgroundColor: colors.glassBorder, marginHorizontal: 8 },
  formCard: { gap: 16 },
  messageField: { minHeight: 96, textAlignVertical: "top" },
  errorText: { fontFamily: type.caption.family, fontSize: 13, color: colors.danger },
  sentText: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
});
