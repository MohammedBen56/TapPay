import { derToRaw, type Signer } from '@tappay/shared';
import { SERVER_BASE_URL } from '../config/serverUrl';
import {
  generateIdentityKey as nativeGenerateIdentityKey,
  getIdentityPublicKey as nativeGetIdentityPublicKey,
  signWithIdentityKey as nativeSignWithIdentityKey,
} from '../native/TapPayNative';
import { base64ToBytes, bytesToBase64 } from '../util/base64';
import { uuidv4 } from '../util/uuid';

export interface EnrolledIdentity {
  /** Both the KeyStore alias suffix and the wire `device_id` sent to the server
   * -- one identity key per enrolled device, per spec's `devices` table. */
  deviceId: string;
  accountId: string;
  strongBoxBacked: boolean;
}

/**
 * Full enrollment flow (M1 Step 6 native calls + Step 7 server endpoints):
 * fetch a server-issued attestation challenge, generate the hardware-backed
 * identity key against it, then register the resulting public key +
 * attestation chain with the server -- verified there against Google roots,
 * never trusted locally (spec §2.5).
 */
export async function enrollDevice(email: string): Promise<EnrolledIdentity> {
  const deviceId = uuidv4();

  const nonceRes = await fetch(`${SERVER_BASE_URL}/devices/enroll/nonce`);
  if (!nonceRes.ok) {
    throw new Error(`failed to fetch enrollment nonce: ${nonceRes.status}`);
  }
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  const strongBoxBacked = await nativeGenerateIdentityKey(deviceId, base64ToBytes(nonce));
  const { publicKey, attestationChain } = await nativeGetIdentityPublicKey(deviceId);

  const enrollRes = await fetch(`${SERVER_BASE_URL}/devices/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      device_id: deviceId,
      platform: 'android',
      identity_pubkey: bytesToBase64(publicKey),
      attestation_chain: attestationChain.map(bytesToBase64),
    }),
  });
  if (!enrollRes.ok) {
    throw new Error(`enrollment failed: ${enrollRes.status} ${await enrollRes.text()}`);
  }
  const { account_id: accountId } = (await enrollRes.json()) as { account_id: string };

  return { deviceId, accountId, strongBoxBacked };
}

/**
 * Fetches a fresh server-signed freshness token (M2, GET /devices/:id/freshness-
 * token) -- the precondition spec §5 requires before a Mode C offline send
 * ("payer holds a freshness_token issued within 24h"). Call this opportunistic-
 * ally whenever online (e.g. right after enrollment, or before going offline)
 * and cache the result locally; OfflineScreen.tsx checks the cached token's age
 * client-side before allowing an offline send, and the server independently
 * re-verifies it at /tx/sync time -- this call itself does no local caching.
 */
export async function fetchFreshnessToken(deviceId: string): Promise<string> {
  const res = await fetch(`${SERVER_BASE_URL}/devices/${deviceId}/freshness-token`);
  if (!res.ok) {
    throw new Error(`failed to fetch freshness token: ${res.status}`);
  }
  const { token } = (await res.json()) as { token: string };
  return token;
}

/**
 * A `packages/shared` `Signer` bound to one enrolled device's hardware key --
 * shows a system biometric prompt on every call. Android's Signature API
 * returns a DER-encoded signature; COSE wants raw r||s, hence the conversion
 * here rather than in the native layer, where it would be tested far less
 * thoroughly than packages/shared's centralized DER vector test (Step 5).
 */
export function createIdentitySigner(deviceId: string): Signer {
  return async (bytesToSign: Uint8Array) => {
    const der = await nativeSignWithIdentityKey(deviceId, bytesToSign);
    return derToRaw(der);
  };
}
