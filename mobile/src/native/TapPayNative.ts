import { requireNativeModule, type EventSubscription } from 'expo-modules-core';

export type Vec3 = [number, number, number];

export interface SensorSample {
  t_device_ns: number;
  accel: Vec3;
  gyro: Vec3;
  mag: Vec3;
}

export interface SensorBatchEvent {
  samples: SensorSample[];
}

export interface RssiSampleEvent {
  t_device_ns: number;
  dbm: number;
  peerAddr: string | null;
}

interface TapPayNativeModuleEvents {
  onSensorBatch: (event: SensorBatchEvent) => void;
  onRssiSample: (event: RssiSampleEvent) => void;
}

/** Shape resolved by Expo's `permissions.askForPermissions` (androidx PermissionsService). */
interface PermissionsBundle {
  status: 'granted' | 'denied' | 'undetermined';
  granted: boolean;
  canAskAgain: boolean;
  expires: 'never' | number;
}

export interface IdentityPublicKeyResult {
  /** Raw 33-byte SEC1-compressed P-256 public key. */
  publicKey: Uint8Array;
  /** Raw DER-encoded attestation certificates, leaf first. Unverified locally --
   * the server verifies the chain against Google roots at enrollment (M1 Step 7). */
  attestationChain: Uint8Array[];
}

interface TapPayNativeModuleType {
  requestPermissions(): Promise<PermissionsBundle>;
  startStreaming(): Promise<void>;
  stopStreaming(): Promise<void>;
  /** Returns true if StrongBox-backed, false if it fell back to TEE (spec §3.2 --
   * an accepted degradation, not a failure). */
  generateIdentityKey(deviceId: string, challenge: Uint8Array): Promise<boolean>;
  getIdentityPublicKey(deviceId: string): Promise<IdentityPublicKeyResult>;
  /** Shows a system BiometricPrompt before signing; rejects on cancel/failure.
   * Returns Java's DER-encoded signature -- convert with
   * `@tappay/shared`'s `derToRaw` before use in a COSE_Sign1 structure. */
  signWithIdentityKey(deviceId: string, bytesToSign: Uint8Array): Promise<Uint8Array>;
  addListener<EventName extends keyof TapPayNativeModuleEvents>(
    eventName: EventName,
    listener: TapPayNativeModuleEvents[EventName]
  ): EventSubscription;
}

// Must match Name("TappayNative") registered in
// modules/tappay-native/android/.../TappayNativeModule.kt exactly.
const NativeModule = requireNativeModule<TapPayNativeModuleType>('TappayNative');

/** Requests BLUETOOTH_SCAN / BLUETOOTH_ADVERTISE / BLUETOOTH_CONNECT at runtime. */
export async function requestPermissions(): Promise<boolean> {
  const result = await NativeModule.requestPermissions();
  return result.granted;
}

/** Starts 100Hz accel/gyro/mag sampling and the BLE advertise+scan pair. */
export function startStreaming(): Promise<void> {
  return NativeModule.startStreaming();
}

export function stopStreaming(): Promise<void> {
  return NativeModule.stopStreaming();
}

export function onSensorBatch(listener: (event: SensorBatchEvent) => void): EventSubscription {
  return NativeModule.addListener('onSensorBatch', listener);
}

export function onRssiSample(listener: (event: RssiSampleEvent) => void): EventSubscription {
  return NativeModule.addListener('onRssiSample', listener);
}

/** Generates the hardware-backed identity key for `deviceId`, if one doesn't
 * already exist for it. `challenge` must be a fresh nonce from the server's
 * enrollment endpoint (see src/crypto/identity.ts), not generated locally. */
export function generateIdentityKey(deviceId: string, challenge: Uint8Array): Promise<boolean> {
  return NativeModule.generateIdentityKey(deviceId, challenge);
}

export function getIdentityPublicKey(deviceId: string): Promise<IdentityPublicKeyResult> {
  return NativeModule.getIdentityPublicKey(deviceId);
}

export function signWithIdentityKey(deviceId: string, bytesToSign: Uint8Array): Promise<Uint8Array> {
  return NativeModule.signWithIdentityKey(deviceId, bytesToSign);
}
