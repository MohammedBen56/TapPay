import { bytesToUuid, decodeDeviceCredential, derToRaw, verifyCoseSign1, type DeviceCredential, type Signer } from '@tappay/shared';
import { getServerPublicKeyBytes } from '../config/serverPublicKey';
import { SERVER_BASE_URL } from '../config/serverUrl';
import { getEnrolledIdentity, saveEnrolledIdentity } from '../db/offlineIntents';
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
 *
 * Idempotent per email: the previous enrolled identity is cached locally
 * (`db/offlineIntents.ts`'s `identity` table) and reused as long as its
 * hardware key still exists in the KeyStore, so a screen switch or app
 * restart doesn't mint a fresh device_id and orphan the Mode C SQLite
 * queues, which are keyed by device_id. `nativeGetIdentityPublicKey` throws
 * `IdentityKeyNotFoundException` (surfaced as a rejected promise) when the
 * KeyStore alias is gone -- e.g. app data was cleared without clearing the
 * KeyStore, or vice versa -- which is exactly the "stale cache, do a real
 * enroll" signal this falls through on.
 */
export async function enrollDevice(email: string): Promise<EnrolledIdentity> {
  const cached = await getEnrolledIdentity(email);
  if (cached) {
    try {
      await nativeGetIdentityPublicKey(cached.deviceId);
      return cached;
    } catch {
      // Cached row's hardware key is gone -- fall through to a real enroll below.
    }
  }

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

  const identity = { deviceId, accountId, strongBoxBacked };
  await saveEnrolledIdentity(email, identity);
  return identity;
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
 * Fetches a peer's server-signed device credential (GET /devices/:id/credential)
 * and verifies it against the pinned server key, the exact analogue of
 * fetchFreshnessToken above. This is the ONLY trustworthy way to learn a peer's
 * identity_pubkey for authenticated session ECDH -- trust-on-first-use (just
 * believing whatever pubkey the peer's ephemeral-key message claims) would
 * reopen the MITM hole authentication exists to close. Returns null rather than
 * throwing on any verification failure or non-200 response, since the caller's
 * job either way is "fail closed, no shared secret" -- see
 * packages/shared/src/crypto/session.ts's deriveSessionKey.
 *
 * The signature alone is NOT enough: it only proves the server vouches for
 * *some* device's pubkey, not that it's the one asked about here -- fetch()
 * is an untrusted channel (plain http://, same posture as fetchFreshnessToken
 * above), so a substituted response body carrying a different, still
 * genuinely server-signed credential (e.g. an attacker's own, obtained by
 * enrolling their own device) would pass signature verification and silently
 * authenticate a session with the wrong identity. Found via /security-review
 * -- the device_id inside the signed payload MUST be checked against what was
 * actually requested.
 */
export async function fetchPeerCredential(deviceId: string): Promise<DeviceCredential | null> {
  const res = await fetch(`${SERVER_BASE_URL}/devices/${deviceId}/credential`);
  if (!res.ok) return null;
  const { credential } = (await res.json()) as { credential: string };
  const verified = verifyCoseSign1(base64ToBytes(credential), getServerPublicKeyBytes());
  if (!verified) return null;
  try {
    const decoded = decodeDeviceCredential(verified.payload);
    if (bytesToUuid(decoded.device_id) !== deviceId) return null;
    return decoded;
  } catch {
    return null;
  }
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
