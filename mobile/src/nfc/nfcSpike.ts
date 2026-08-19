/** NFC-1 validation spike (plan "milestones for NFC sharing", not yet named
 * a plan file). Proves react-native-nfc-manager v4 beta actually links and
 * initializes under this app's forced New Architecture -- the one real
 * compatibility risk named in the research pass, since v3 (the "latest"
 * dist-tag) is legacy-architecture-only. Deliberately temporary: this file
 * and its Profile-screen trigger get replaced by the real reader wrapper
 * (NFC-3) once the emulator side (NFC-2) exists to tap against.
 *
 * Without a peer emulating a tag yet, requestTechnology has nothing to
 * discover -- this only proves the module initializes and the reader
 * session opens/cancels cleanly, not a full read. That's the actual scope
 * of what NFC-1 can validate before NFC-2 exists. */
import NfcManager, { NfcTech } from "react-native-nfc-manager";

export async function runNfcSmokeTest(): Promise<string> {
  const lines: string[] = [];
  try {
    await NfcManager.start();
    lines.push("NfcManager.start(): ok");
  } catch (err) {
    return `NfcManager.start() FAILED: ${String(err)}`;
  }

  try {
    const supported = await NfcManager.isSupported();
    lines.push(`isSupported(): ${supported}`);
    if (!supported) return lines.join("\n");
  } catch (err) {
    lines.push(`isSupported() FAILED: ${String(err)}`);
    return lines.join("\n");
  }

  try {
    const enabled = await NfcManager.isEnabled();
    lines.push(`isEnabled(): ${enabled}`);
  } catch (err) {
    lines.push(`isEnabled() FAILED: ${String(err)}`);
  }

  try {
    const requestPromise = NfcManager.requestTechnology(NfcTech.IsoDep);
    const timeoutPromise = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 4000));
    const result = await Promise.race([requestPromise, timeoutPromise]);
    lines.push(result === "timeout" ? "requestTechnology(IsoDep): session opened, no tag presented (expected)" : "requestTechnology(IsoDep): resolved unexpectedly early");
    await NfcManager.cancelTechnologyRequest();
    lines.push("cancelTechnologyRequest(): ok");
  } catch (err) {
    lines.push(`requestTechnology/cancel FAILED: ${String(err)}`);
  }

  return lines.join("\n");
}
