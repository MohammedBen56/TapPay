import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { StatementResponse, StatementTransaction } from "@tappay/shared";
import { api } from "../../src/api/endpoints";
import { meQueryOptions } from "../../src/api/queries";
import { Card } from "../../src/components/Card";
import { GlassButton } from "../../src/components/GlassButton";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { TextField } from "../../src/components/TextField";
import { colors, radius, type } from "../../src/design/tokens";
import { formatDateTime, formatLongDate, formatMAD, formatRibGrouped } from "../../src/design/format";

type Preset = "30d" | "3m" | "6m" | "ytd" | "custom";

const PRESET_OPTIONS: { value: Preset; label: string }[] = [
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
  { value: "6m", label: "6 months" },
  { value: "ytd", label: "YTD" },
  { value: "custom", label: "Custom" },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function presetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const to = isoDate(now);
  if (preset === "ytd") {
    return { from: `${now.getUTCFullYear()}-01-01`, to };
  }
  const months = preset === "3m" ? 3 : preset === "6m" ? 6 : 0;
  const from = new Date(now);
  if (preset === "30d") {
    from.setUTCDate(from.getUTCDate() - 30);
  } else {
    from.setUTCMonth(from.getUTCMonth() - months);
  }
  return { from: isoDate(from), to };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Ship List v2, owner-requested: date-ranged statement export ("export a
 * transaction of past few months for official purposes like applying to
 * visa") plus a proof-of-balance letter -- two distinct documents sharing
 * one screen since they share the same underlying data (GET /me,
 * GET /accounts/me/statement) and PDF mechanism (the same expo-print +
 * expo-sharing pattern app/transfer/[txUuid].tsx already uses for a single
 * receipt). No date-picker native dependency was added -- presets cover
 * the common cases, and the custom fallback is a typed YYYY-MM-DD field,
 * the same "always have a manual fallback" precedent Send's "Type RIB"
 * method already established for this app. */
export default function StatementsScreen(): React.JSX.Element {
  const meQuery = useQuery(meQueryOptions);
  const balanceQuery = useQuery({ queryKey: ["balance", "default"], queryFn: () => api.balance(), staleTime: 15_000 });
  const [preset, setPreset] = useState<Preset>("3m");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [statementBusy, setStatementBusy] = useState(false);
  const [letterBusy, setLetterBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => (preset === "custom" ? { from: customFrom, to: customTo } : presetRange(preset)), [preset, customFrom, customTo]);
  const rangeValid = DATE_RE.test(range.from) && DATE_RE.test(range.to) && range.from <= range.to;

  const handleGenerateStatement = async (): Promise<void> => {
    setError(null);
    if (!rangeValid) {
      setError("Enter a valid date range (YYYY-MM-DD), with the start on or before the end.");
      return;
    }
    setStatementBusy(true);
    try {
      const statement = await api.statement(range);
      const html = statementHtml(statement);
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: "Share statement" });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Couldn't generate statement", "Something went wrong. Try again.");
    } finally {
      setStatementBusy(false);
    }
  };

  const handleGenerateLetter = async (): Promise<void> => {
    const me = meQuery.data;
    const balance = balanceQuery.data;
    if (!me || !balance) return;
    setLetterBusy(true);
    try {
      const reference = `TPY-${me.account_id.slice(0, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
      const html = proofOfBalanceHtml({ me, balance: balance.available_balance, currency: balance.currency, reference });
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: "Share proof of balance" });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Couldn't generate letter", "Something went wrong. Try again.");
    } finally {
      setLetterBusy(false);
    }
  };

  return (
    <ScreenBackground>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Animated.View entering={FadeIn.duration(400)}>
          <Text style={styles.sectionLabel}>Statement</Text>
          <Card style={styles.card}>
            <Text style={styles.body}>
              Generate an itemized PDF statement for a date range — useful for visa applications and other official
              purposes.
            </Text>
            <SegmentedControl options={PRESET_OPTIONS} value={preset} onChange={setPreset} />
            {preset === "custom" ? (
              <View style={styles.customRow}>
                <View style={styles.customField}>
                  <TextField label="From" placeholder="YYYY-MM-DD" value={customFrom} onChangeText={setCustomFrom} autoCapitalize="none" />
                </View>
                <View style={styles.customField}>
                  <TextField label="To" placeholder="YYYY-MM-DD" value={customTo} onChangeText={setCustomTo} autoCapitalize="none" />
                </View>
              </View>
            ) : (
              <Text style={styles.rangePreview}>
                {range.from} → {range.to}
              </Text>
            )}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <GlassButton label="Generate statement" onPress={() => void handleGenerateStatement()} loading={statementBusy} style={styles.button} />
          </Card>
        </Animated.View>

        <Animated.View entering={FadeIn.delay(80).duration(400)}>
          <Text style={styles.sectionLabel}>Proof of balance</Text>
          <Card style={styles.card}>
            <Text style={styles.body}>
              A single-page letter confirming your current balance as of today — no transaction history, just what
              some official processes ask for separately from a statement.
            </Text>
            <GlassButton
              label="Generate letter"
              variant="ghost"
              onPress={() => void handleGenerateLetter()}
              loading={letterBusy}
              disabled={!meQuery.data || !balanceQuery.data}
              style={styles.button}
            />
          </Card>
        </Animated.View>
      </ScrollView>
    </ScreenBackground>
  );
}

function statementHtml(statement: StatementResponse): string {
  let running = BigInt(statement.opening_balance);
  const rows = statement.transactions
    .map((t: StatementTransaction) => {
      const signed = t.direction === "credit" ? BigInt(t.amount) : -BigInt(t.amount);
      running += signed;
      return `<tr>
        <td style="padding:6px 0; color:${colors.textSecondary};">${formatDateTime(t.created_at)}</td>
        <td style="padding:6px 0;">${t.counterparty_name ?? "Unknown"}</td>
        <td style="padding:6px 0; color:${colors.textSecondary};">${t.reference ?? "—"}</td>
        <td style="padding:6px 0; text-align:right;">${t.direction === "credit" ? "+" : "-"}${formatMAD(t.amount)}</td>
        <td style="padding:6px 0; text-align:right; color:${colors.textSecondary};">${formatMAD(running.toString())}</td>
      </tr>`;
    })
    .join("");

  return `
    <html>
      <body style="font-family: -apple-system, Helvetica, Arial, sans-serif; background:${colors.ground}; color:${colors.bone}; padding:40px;">
        <h1 style="font-size:14px; letter-spacing:2px; color:${colors.textSecondary}; text-transform:uppercase;">TapPay Statement</h1>
        <p style="color:${colors.textSecondary};">${statement.display_name} — ${formatRibGrouped(statement.rib)}</p>
        <p style="color:${colors.textSecondary};">${statement.from} to ${statement.to}</p>
        <hr style="border-color:${colors.glassBorder}; margin:20px 0;" />
        <table style="width:100%; font-size:13px;">
          <tr><td style="color:${colors.textSecondary};">Opening balance</td><td style="text-align:right;">${formatMAD(statement.opening_balance)} ${statement.currency}</td></tr>
          <tr><td style="color:${colors.textSecondary};">Closing balance</td><td style="text-align:right;">${formatMAD(statement.closing_balance)} ${statement.currency}</td></tr>
        </table>
        <hr style="border-color:${colors.glassBorder}; margin:20px 0;" />
        <table style="width:100%; font-size:12px; border-collapse:collapse;">
          <thead>
            <tr style="color:${colors.textSecondary}; text-transform:uppercase; font-size:10px; letter-spacing:1px;">
              <td style="padding-bottom:8px;">Date</td>
              <td style="padding-bottom:8px;">Counterparty</td>
              <td style="padding-bottom:8px;">Reference</td>
              <td style="padding-bottom:8px; text-align:right;">Amount</td>
              <td style="padding-bottom:8px; text-align:right;">Balance</td>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="5" style="padding:20px 0; color:${colors.textSecondary};">No transactions in this period.</td></tr>`}</tbody>
        </table>
      </body>
    </html>
  `;
}

function proofOfBalanceHtml(args: {
  me: { display_name: string; rib: string; iban: string; customer_id: string };
  balance: string;
  currency: string;
  reference: string;
}): string {
  const today = formatLongDate(new Date().toISOString());
  return `
    <html>
      <body style="font-family: -apple-system, Helvetica, Arial, sans-serif; background:${colors.ground}; color:${colors.bone}; padding:48px;">
        <h1 style="font-size:14px; letter-spacing:2px; color:${colors.textSecondary}; text-transform:uppercase;">TapPay</h1>
        <p style="color:${colors.textSecondary}; margin-top:24px;">${today}</p>
        <h2 style="font-size:20px; margin-top:32px;">Proof of Balance</h2>
        <p style="line-height:1.7; margin-top:16px;">
          This letter confirms that, as of the date above, <strong>${args.me.display_name}</strong>
          (account holder, customer ID ${args.me.customer_id}) holds an account with TapPay with a
          balance of <strong>${formatMAD(args.balance)} ${args.currency}</strong>.
        </p>
        <table style="width:100%; font-size:13px; margin-top:24px;">
          <tr><td style="color:${colors.textSecondary}; padding:4px 0;">RIB</td><td style="text-align:right;">${formatRibGrouped(args.me.rib)}</td></tr>
          <tr><td style="color:${colors.textSecondary}; padding:4px 0;">IBAN</td><td style="text-align:right;">${args.me.iban}</td></tr>
          <tr><td style="color:${colors.textSecondary}; padding:4px 0;">Reference</td><td style="text-align:right; font-family:monospace;">${args.reference}</td></tr>
        </table>
        <p style="color:${colors.textSecondary}; font-size:11px; margin-top:48px; line-height:1.6;">
          TapPay is a demo product. It moves no real funds and is not a licensed bank — this letter is a
          demonstration document, not a real proof of funds.
        </p>
      </body>
    </html>
  `;
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 20, paddingBottom: 80 },
  sectionLabel: {
    fontFamily: type.sectionLabel.family,
    fontSize: type.sectionLabel.size,
    letterSpacing: type.sectionLabel.letterSpacing,
    color: colors.textQuiet,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  card: { gap: 16, borderRadius: radius.lg },
  body: { fontFamily: type.body.family, fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  customRow: { flexDirection: "row", gap: 12 },
  customField: { flex: 1 },
  rangePreview: { fontFamily: type.bodyStrong.family, fontSize: 14, color: colors.bone },
  errorText: { fontFamily: type.caption.family, fontSize: 13, color: colors.danger },
  button: { marginTop: 4 },
});
