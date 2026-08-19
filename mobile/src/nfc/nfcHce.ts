/** NFC-2/3: the "Share via NFC" (Profile screen) side. Wraps the same
 * `TappayNative` Expo module the parked BLE work uses (mobile/modules/
 * tappay-native) -- NFC-2 added nfcStartSharing/nfcStopSharing to it rather
 * than creating a second native module, since it was already linked and
 * compiled. This wrapper is deliberately separate from
 * mobile/src/parked/native/TapPayNative.ts (the parked BLE/sensor/identity
 * wrapper) -- NFC is a live feature, not resumed parked work, and doesn't
 * need any of that file's BLE/sensor/KeyStore surface. */
import { requireNativeModule } from "expo-modules-core";

interface TappayNativeNfcSlice {
  nfcStartSharing: (payloadUtf8: string) => Promise<void>;
  nfcStopSharing: () => Promise<void>;
}

const NativeModule = requireNativeModule<TappayNativeNfcSlice>("TappayNative");

/** Starts emulating an NFC tag that serves `payloadUtf8` (the same
 * `encodeProfileQr(...)` JSON string the Profile QR code carries) to
 * whichever phone next taps this one and reads the custom AID
 * (NfcHceService.kt). Overwrites any previously-shared payload. */
export async function startNfcSharing(payloadUtf8: string): Promise<void> {
  await NativeModule.nfcStartSharing(payloadUtf8);
}

/** Stops serving any payload -- a reader tapping after this gets a
 * "no data" response instead of a stale share. */
export async function stopNfcSharing(): Promise<void> {
  await NativeModule.nfcStopSharing();
}
