import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeDeviceCredential, decodeSessionHello, encodeSessionHello } from "./cbor.js";
import { decodeCoseSign1Unverified, signCoseSign1, verifyCoseSign1, type Signer } from "./cose.js";
import type { DeviceCredential, SessionHello } from "../types.js";

/**
 * Authenticated session ECDH (CLAUDE.md §5's "code that does not exist yet"
 * block; spec §3.3). Transport-agnostic on purpose -- M3's BLE GATT layer will
 * be this module's first caller, but nothing here assumes a radio, a specific
 * message ordering beyond hello-then-derive, or even that both sides are on
 * the same physical channel. `deriveSessionKey` NEVER falls back to an
 * unauthenticated key on any failure; every rejection path returns `null`, and
 * callers must treat `null` as "no session, do not proceed" -- fail closed,
 * per spec §3.3's explicit instruction not to fall back to anonymous ECDH.
 */

/** How far a peer's SessionHello.ts may drift from our clock and still be
 * accepted. A config-driven default, not a hardcoded constant callers can't
 * override -- CLAUDE.md §5/§8's "config over constants" rule, mirrored here
 * for shared code the way server/src/config.ts does it for the server. */
export const DEFAULT_SESSION_HELLO_WINDOW_MS = 30_000;

export interface EphemeralKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array; // 33-byte SEC1-compressed P-256
}

/**
 * `randomBytes` defaults to @noble/hashes's own CSPRNG, which delegates to
 * `globalThis.crypto.getRandomValues` -- present on Node (this default is
 * exactly what server-side and vitest callers get, unchanged) but NOT
 * present on Hermes/React Native without an explicit polyfill. Found via
 * on-device testing: this function threw "crypto.getRandomValues must be
 * defined" the first time it actually ran on a phone, since nothing in this
 * package had ever needed CSPRNG randomness before (verification-only code
 * doesn't generate keys). Mobile callers MUST pass their own source --
 * `expo-crypto`'s `Crypto.getRandomBytes`, the same primitive
 * TapScreen.tsx already uses for its receiver nonce -- rather than this
 * package silently depending on a global that isn't there. `p256.keygen`'s
 * `seed` parameter (48 bytes for P-256, `p256.lengths.seed`) is the
 * injection point: when provided, it skips @noble/curves' own internal
 * randomBytes() call entirely.
 */
// p256.lengths.seed is typed as `number | undefined` (the lengths shape is
// shared across curves that don't all define a seed length), but P-256's ECDH
// interface always provides one -- asserted once here rather than on every
// generateEphemeralKeyPair call. `as number` (not just a narrowed flow check)
// is required so the fixed type, not just a flow fact, is visible from inside
// generateEphemeralKeyPair's closure below -- TS narrowing on a module-scope
// binding doesn't propagate into a separately-declared function body.
if (p256.lengths.seed === undefined) {
  throw new Error("@noble/curves p256 unexpectedly has no seed length");
}
const P256_SEED_LENGTH = p256.lengths.seed as number;

export function generateEphemeralKeyPair(randomBytes: (length: number) => Uint8Array = nobleRandomBytes): EphemeralKeyPair {
  return p256.keygen(randomBytes(P256_SEED_LENGTH));
}

export interface CreateSessionHelloParams {
  txUuid: Uint8Array;
  deviceId: Uint8Array;
  ephPublicKey: Uint8Array;
  sign: Signer;
  /** This device's own server-signed DeviceCredential, COSE_Sign1 bytes
   * verbatim (M3 Milestone 3) -- see SessionHello.own_credential's doc
   * comment (types.ts) for why this rides inside the hello instead of
   * requiring the PEER to fetch it live. */
  ownCredentialCose: Uint8Array;
  now?: number;
}

/** Signs the WHOLE hello struct (see SessionHello's doc comment for why, not
 * just the bare ephemeral key). `sign` is a plain `packages/shared` `Signer`,
 * so `createIdentitySigner` (mobile's biometric-gated StrongBox signer) drops
 * in with zero native changes. */
export async function createSessionHello(params: CreateSessionHelloParams): Promise<Uint8Array> {
  const hello: SessionHello = {
    tx_uuid: params.txUuid,
    device_id: params.deviceId,
    eph_pubkey: params.ephPublicKey,
    ts: params.now ?? Date.now(),
    own_credential: params.ownCredentialCose,
  };
  return signCoseSign1(encodeSessionHello(hello), params.sign);
}

/**
 * Verifies `credentialCose` (a DeviceCredential's COSE_Sign1 bytes) against
 * `serverPublicKey` -- the pinned key, always available locally, no network
 * call -- and cross-checks its decoded `device_id` against `expectedDeviceId`.
 * The signature alone is not enough: it only proves the server vouches for
 * *some* device's pubkey, not that it's the one claimed here -- a
 * substituted-but-genuinely-signed credential for a different (e.g.
 * attacker-enrolled) device would otherwise pass. Same two-part check
 * `mobile/src/crypto/identity.ts`'s `fetchPeerCredential` already does for
 * the live-fetch path; factored out here so `deriveSessionKey` and any
 * future embedded-credential caller share one implementation instead of
 * duplicating this exact check (CLAUDE.md §10's "5-instance confirmed
 * pattern" -- a client-suppliable identifier insufficiently bound to what it
 * should be scoped to). Returns `null` on any failure, never throws.
 */
export function verifyEmbeddedCredential(
  credentialCose: Uint8Array,
  expectedDeviceId: Uint8Array,
  serverPublicKey: Uint8Array,
): DeviceCredential | null {
  let verified: ReturnType<typeof verifyCoseSign1>;
  try {
    verified = verifyCoseSign1(credentialCose, serverPublicKey);
  } catch {
    return null;
  }
  if (!verified) return null;
  let credential: DeviceCredential;
  try {
    credential = decodeDeviceCredential(verified.payload);
  } catch {
    return null;
  }
  if (!bytesEqual(credential.device_id, expectedDeviceId)) return null;
  return credential;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** Exported for reuse anywhere two byte arrays need constant-shape comparison
 * (e.g. the mobile receipt-binding checks in TapScreen.tsx/OfflineScreen.tsx --
 * comparing a decoded TxReceipt's recipient_device_id/receiver_nonce against
 * what the caller itself generated or signed). Not cryptographic
 * constant-time comparison (this codebase's signature verification already
 * gets that for free from the underlying ECDSA library) -- just a correct,
 * shared byte-equality check instead of N duplicated ad-hoc ones. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0;
}

/**
 * Canonical HKDF `info`: both (device_id, eph_pubkey) pairs, ordered by sorting
 * on device_id lexicographically (byte-wise) -- NOT by who initiated. This is
 * what lets A and B derive the identical key regardless of which side sent its
 * hello first, the same ordering discipline server/src/db/locking.ts uses for
 * row locks (sort first, then act, so both participants agree on order without
 * needing to communicate about it).
 */
function buildTranscript(
  a: { deviceId: Uint8Array; ephPubkey: Uint8Array },
  b: { deviceId: Uint8Array; ephPubkey: Uint8Array },
): Uint8Array {
  const [first, second] = compareBytes(a.deviceId, b.deviceId) <= 0 ? [a, b] : [b, a];
  const out = new Uint8Array(first.deviceId.length + first.ephPubkey.length + second.deviceId.length + second.ephPubkey.length);
  let offset = 0;
  for (const part of [first.deviceId, first.ephPubkey, second.deviceId, second.ephPubkey]) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface DeriveSessionKeyParams {
  txUuid: Uint8Array;
  ourDeviceId: Uint8Array;
  ourEphSecretKey: Uint8Array;
  ourEphPublicKey: Uint8Array;
  /** The peer's SessionHello, as a signed COSE_Sign1 -- verified against the
   * identity_pubkey extracted from its OWN embedded `own_credential` field
   * (see verifyEmbeddedCredential), not a pubkey the caller already has. */
  peerHelloCose: Uint8Array;
  /** The pinned server public key (M3 Milestone 3) -- always available
   * locally, no network call needed. Replaces the old `peerIdentityPubkey`
   * param: the peer's identity_pubkey is no longer supplied by the caller,
   * it's extracted from the peer's own embedded, server-signed credential
   * and verified against THIS key instead. Never trust-on-first-use from
   * the hello message itself, or this function would authenticate nothing
   * -- the embedded credential's own signature is what still does that. */
  serverPublicKey: Uint8Array;
  now?: number;
  helloWindowMs?: number;
}

/**
 * Verifies the peer's hello, checks it's genuinely for this transaction and
 * not a reflection of our own hello, derives the ECDH shared secret, and folds
 * a transcript binding both device ids + ephemeral pubkeys + tx_uuid into an
 * HKDF-SHA256-derived 32-byte session key. Returns `null` on ANY failure --
 * see this module's top comment on why there is no fallback path.
 */
export function deriveSessionKey(params: DeriveSessionKeyParams): Uint8Array | null {
  // Read the hello's fields WITHOUT trusting them yet -- same "read kid,
  // then verify" pattern used elsewhere in this codebase (e.g.
  // SessionDemoScreen.tsx's remote-peer mode). Nothing decoded here is
  // trusted until the outer signature check below succeeds; it's only used
  // to learn WHICH pubkey that check should even be run against, since the
  // peer's identity_pubkey now travels inside its own hello (M3 Milestone 3)
  // instead of being supplied by the caller from a live fetch.
  let unverifiedHello: SessionHello;
  try {
    unverifiedHello = decodeSessionHello(decodeCoseSign1Unverified(params.peerHelloCose).payload);
  } catch {
    return null;
  }

  const credential = verifyEmbeddedCredential(unverifiedHello.own_credential, unverifiedHello.device_id, params.serverPublicKey);
  if (!credential) return null;

  // THIS is the actual authentication step: re-verify the WHOLE hello
  // (including the fields read unverified above) against the pubkey the
  // embedded credential just proved really belongs to `unverifiedHello.device_id`.
  // verifyCoseSign1 itself never throws, but the malformed-CBOR decode inside
  // it does (decodeCoseSign1Structure) -- wrapped so garbage peerHelloCose
  // hits this function's own documented "null on ANY failure" contract
  // instead of an uncaught exception a caller written to that contract
  // wouldn't expect. Found via /security-review.
  let verified: ReturnType<typeof verifyCoseSign1>;
  try {
    verified = verifyCoseSign1(params.peerHelloCose, credential.identity_pubkey);
  } catch {
    return null;
  }
  if (!verified) return null;

  let peerHello: SessionHello;
  try {
    peerHello = decodeSessionHello(verified.payload);
  } catch {
    return null;
  }

  // decodeSessionHello only checks CBOR array arity, not field lengths -- a
  // signer (even a legitimately enrolled one gone rogue) controls these bytes.
  // Fixed lengths are enforced here rather than trusted implicitly: unequal
  // device_id lengths between the two sides would make buildTranscript's
  // concatenation ambiguous (no length-prefixing), and a wrong-length
  // eph_pubkey would fail inside getSharedSecret anyway -- rejecting explicitly
  // up front is clearer than relying on that incidental failure. Found via
  // /security-review.
  if (peerHello.device_id.length !== params.ourDeviceId.length || peerHello.eph_pubkey.length !== params.ourEphPublicKey.length) {
    return null;
  }

  if (!bytesEqual(peerHello.tx_uuid, params.txUuid)) return null;
  // Reflection defense: a hello claiming to be from our own device_id is
  // either a bug or an attacker replaying our own message back at us.
  if (bytesEqual(peerHello.device_id, params.ourDeviceId)) return null;

  const now = params.now ?? Date.now();
  const windowMs = params.helloWindowMs ?? DEFAULT_SESSION_HELLO_WINDOW_MS;
  if (Math.abs(now - peerHello.ts) > windowMs) return null;

  let sharedPoint: Uint8Array;
  try {
    sharedPoint = p256.getSharedSecret(params.ourEphSecretKey, peerHello.eph_pubkey, true);
  } catch {
    return null;
  }
  // Drop the 1-byte compressed-point sign prefix -- only the x-coordinate is
  // used, the standard ECDH convention (the prefix encodes y's parity, which
  // carries no additional entropy an attacker couldn't already derive).
  const sharedX = sharedPoint.slice(1);

  const transcript = buildTranscript(
    { deviceId: params.ourDeviceId, ephPubkey: params.ourEphPublicKey },
    { deviceId: peerHello.device_id, ephPubkey: peerHello.eph_pubkey },
  );

  return hkdf(sha256, sharedX, params.txUuid, transcript, 32);
}

/**
 * A message's direction is derived from the SAME canonical device_id ordering
 * `buildTranscript` already uses -- never a free "initiator"/"responder"
 * string a caller assigns by hand. This closes a real footgun found via
 * /security-review: this module's own domain is a SYMMETRIC bump between two
 * peers with no inherent client/server roles, so nothing stops both sides of
 * a genuine two-party session from each independently deciding "I'll call
 * myself the initiator" -- which would make both sides seal under the same
 * nonce space (byte[0]=0) with overlapping counters, breaking AES-GCM's
 * confidentiality and authenticity outright on nonce reuse. Deriving the
 * direction byte from `compareBytes(senderDeviceId, otherDeviceId)` instead
 * makes the two sides' nonce spaces disjoint by construction, the same way
 * `buildTranscript` already makes both sides agree on transcript order
 * without needing to coordinate who goes first.
 */
function directionByte(senderDeviceId: Uint8Array, otherDeviceId: Uint8Array): number {
  return compareBytes(senderDeviceId, otherDeviceId) <= 0 ? 0 : 1;
}

function buildNonce(direction: number, counter: bigint): Uint8Array {
  if (counter < 0n || counter >= 2n ** 88n) {
    throw new RangeError("session message counter out of range");
  }
  const nonce = new Uint8Array(12);
  nonce[0] = direction;
  let remaining = counter;
  for (let i = 11; i >= 1; i--) {
    nonce[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return nonce;
}

/**
 * Seals `plaintext` with AES-256-GCM under a nonce built from the canonical
 * direction (derived from `ourDeviceId` vs `peerDeviceId`, see directionByte)
 * plus `counter`. `counter` is still the caller's responsibility: it must
 * strictly increase per session and never be reused -- reusing a nonce breaks
 * AES-GCM's guarantees outright. Full duplicate/out-of-order-delivery
 * handling belongs to the transport layer (M3's GATT layer, when built), the
 * same way TLS's record-layer sequence number alone doesn't solve transport
 * reordering either -- this primitive's job is only "never reuse a nonce" and
 * "reject anything not genuinely from the expected peer direction" (see
 * openSessionMessage). The sealed output is `nonce || ciphertext+tag`.
 */
export function sealSessionMessage(
  key: Uint8Array,
  ourDeviceId: Uint8Array,
  peerDeviceId: Uint8Array,
  counter: bigint,
  plaintext: Uint8Array,
): Uint8Array {
  const nonce = buildNonce(directionByte(ourDeviceId, peerDeviceId), counter);
  const ciphertext = gcm(key, nonce).encrypt(plaintext);
  const sealed = new Uint8Array(nonce.length + ciphertext.length);
  sealed.set(nonce, 0);
  sealed.set(ciphertext, nonce.length);
  return sealed;
}

/**
 * Opens a buffer produced by `sealSessionMessage`. Returns `null` on ANY
 * failure -- truncated input, wrong direction, wrong key, or a failed GCM tag
 * check -- never throws, so callers can treat every failure identically:
 * discard the message, do not proceed. Checking the nonce's direction byte
 * against the PEER's canonical role (before ever attempting to decrypt)
 * rejects a message reflected back at its own sender or otherwise tagged with
 * the wrong direction, even though both sides hold the identical symmetric
 * key -- found via /security-review as a gap the original design left
 * entirely to the caller with no structural enforcement.
 */
export function openSessionMessage(key: Uint8Array, ourDeviceId: Uint8Array, peerDeviceId: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < 12) return null;
  const nonce = sealed.slice(0, 12);
  if (nonce[0] !== directionByte(peerDeviceId, ourDeviceId)) return null;
  const ciphertext = sealed.slice(12);
  try {
    return gcm(key, nonce).decrypt(ciphertext);
  } catch {
    return null;
  }
}
