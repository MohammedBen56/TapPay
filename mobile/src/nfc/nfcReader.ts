/** NFC-3: the reader side of "Share via NFC" -- Send screen's "NFC"
 * recipient-input method. Entirely JS: react-native-nfc-manager's IsoDep/
 * transceive exposes raw APDU exchange, which is all the reader side of
 * our custom-AID HCE protocol needs (NfcHceService.kt on the other phone).
 * Single SELECT exchange, payload riding on the SELECT response itself
 * (see NfcHceService.kt's doc comment for why: two-phone testing found a
 * separate SELECT-then-READ round trip failed intermittently when contact
 * broke between the two exchanges). */
import NfcManager, { NfcAdapter, NfcTech } from "react-native-nfc-manager";
import { decodeProfileQr, type ProfileQrPayload } from "../qr/profileQr";

// Must match NfcHceService.kt's AID byte-for-byte.
const AID = [0xf0, 0x54, 0x41, 0x50, 0x50, 0x41, 0x59];
const SELECT_APDU = [0x00, 0xa4, 0x04, 0x00, AID.length, ...AID, 0x00];
const SW_OK = [0x90, 0x00];
const SW_NO_PAYLOAD = [0x6a, 0x88];

function trailingSw(response: number[]): [number, number] | null {
  if (response.length < 2) return null;
  return [response[response.length - 2]!, response[response.length - 1]!];
}

function swEquals(sw: [number, number] | null, expected: number[]): boolean {
  return sw !== null && sw[0] === expected[0] && sw[1] === expected[1];
}

// IsoDep's default Android timeout (~618ms) is tight for a marginal/
// edge-of-range tap between two different phone models' antennas --
// raising it gives a weak connection more time to complete the one
// exchange we need, without adding any latency to a fast, clean tap
// (transceive still returns the moment a response arrives).
const ISO_DEP_TIMEOUT_MS = 3000;

/** Hermes doesn't reliably provide a global TextDecoder (same reason
 * src/util/base64.ts hand-rolls base64 instead of Buffer/btoa) -- decode
 * UTF-8 bytes manually rather than risk it. display_name can contain
 * accented characters, so this needs real multi-byte handling, not just
 * ASCII passthrough. */
function utf8BytesToString(bytes: number[]): string {
  let result = "";
  let i = 0;
  while (i < bytes.length) {
    const byte1 = bytes[i]!;
    if (byte1 < 0x80) {
      result += String.fromCharCode(byte1);
      i += 1;
    } else if (byte1 >= 0xc0 && byte1 < 0xe0 && i + 1 < bytes.length) {
      const byte2 = bytes[i + 1]!;
      result += String.fromCharCode(((byte1 & 0x1f) << 6) | (byte2 & 0x3f));
      i += 2;
    } else if (byte1 >= 0xe0 && byte1 < 0xf0 && i + 2 < bytes.length) {
      const byte2 = bytes[i + 1]!;
      const byte3 = bytes[i + 2]!;
      result += String.fromCharCode(((byte1 & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f));
      i += 3;
    } else if (byte1 >= 0xf0 && i + 3 < bytes.length) {
      const byte2 = bytes[i + 1]!;
      const byte3 = bytes[i + 2]!;
      const byte4 = bytes[i + 3]!;
      const codepoint = ((byte1 & 0x07) << 18) | ((byte2 & 0x3f) << 12) | ((byte3 & 0x3f) << 6) | (byte4 & 0x3f);
      result += String.fromCodePoint(codepoint);
      i += 4;
    } else {
      i += 1; // malformed byte -- skip rather than throw
    }
  }
  return result;
}

export type NfcReadOutcome<T> =
  | { status: "success"; payload: T }
  | { status: "no_payload" } // reader touched a phone that isn't currently sharing
  | { status: "not_a_tappay_tag" } // SELECT failed -- some other NFC tag/card
  | { status: "invalid_payload" } // read succeeded but the bytes weren't a valid payload for the given decoder
  | { status: "cancelled" }
  | { status: "error"; message: string };

/** Opens an NFC reader session, waits for a tap, exchanges the single SELECT
 * APDU, and always tears the session down (success, failure, or timeout)
 * before resolving. Caller supplies the timeout -- the Send screen's "hold
 * phones together" UI decides how long to wait before giving up.
 *
 * Ship List v2 Wave 2 Phase 7: generalized from a hardcoded
 * decodeProfileQr call to an injectable `decode` function, so the same
 * transport (the AID/APDU exchange, NfcHceService.kt on the sharing
 * phone) can carry money-request payloads too, not just profile-share
 * ones -- the wire bytes are opaque UTF-8 either way, only the JSON
 * shape on top differs. `readNfcProfile` below is now a one-line wrapper
 * over this, so the existing Profile/Send NFC-share flow is unaffected. */
export async function readNfcPayload<T>(timeoutMs: number, decode: (raw: string) => T | null): Promise<NfcReadOutcome<T>> {
  try {
    await NfcManager.start();
  } catch (err) {
    return { status: "error", message: `NFC unavailable: ${String(err)}` };
  }

  try {
    // Default reader mode polls Type A/B/F/V in a cycle and also probes for
    // NDEF content -- both add real per-poll latency for zero benefit here,
    // since HCE only ever answers Type-A polling and NfcHceService isn't an
    // NDEF tag. Restricting to exactly what's needed is the standard fix
    // for slow/flaky phone-to-phone HCE taps (same flags Google's own HCE
    // sample code uses) -- added after live testing found connecting
    // inconsistent/slow with the default (unrestricted) reader mode.
    const requestPromise = NfcManager.requestTechnology(NfcTech.IsoDep, {
      readerModeFlags: NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
    });
    const timeoutPromise = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
    const result = await Promise.race([requestPromise, timeoutPromise]);
    if (result === "timeout") {
      return { status: "cancelled" };
    }

    try {
      await NfcManager.setTimeout(ISO_DEP_TIMEOUT_MS);
    } catch {
      // Not fatal if unsupported on this device -- falls back to the platform default.
    }

    const selectResponse = await NfcManager.isoDepHandler.transceive(SELECT_APDU);
    const sw = trailingSw(selectResponse);
    if (swEquals(sw, SW_NO_PAYLOAD)) {
      return { status: "no_payload" };
    }
    if (!swEquals(sw, SW_OK)) {
      return { status: "not_a_tappay_tag" };
    }

    const payloadBytes = selectResponse.slice(0, -2);
    const payloadUtf8 = utf8BytesToString(payloadBytes);
    const payload = decode(payloadUtf8);
    if (!payload) {
      return { status: "invalid_payload" };
    }
    return { status: "success", payload };
  } catch (err) {
    return { status: "error", message: String(err) };
  } finally {
    try {
      await NfcManager.cancelTechnologyRequest();
    } catch {
      // already cancelled/torn down -- fine
    }
  }
}

/** The pre-Phase-7 entry point, unaffected by the generalization above. */
export async function readNfcProfile(timeoutMs: number): Promise<NfcReadOutcome<ProfileQrPayload>> {
  return readNfcPayload(timeoutMs, decodeProfileQr);
}
