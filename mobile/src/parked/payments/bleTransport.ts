import {
  acceptReceivedCounter,
  bytesToUuid,
  createSessionCounterState,
  createSessionHello,
  decodeCoseSign1Unverified,
  decodeSessionHello,
  deriveSessionKey,
  generateEphemeralKeyPair,
  nextSendCounter,
  openSessionMessage,
  sealSessionMessage,
  uuidToBytes,
} from '@tappay/shared';
import * as Crypto from 'expo-crypto';
import type { EventSubscription } from 'expo-modules-core';

import { getServerPublicKeyBytes } from '../config/serverPublicKey';
import { createIdentitySigner, type EnrolledIdentity } from '../crypto/identity';
import { getCachedOwnCredential } from '../db/offlineIntents';
import {
  bleConnectToPeer,
  bleDisconnect,
  bleSend,
  bleStartAdvertising,
  onBleTransportConnectionState,
  onBleTransportData,
} from '../native/TapPayNative';
import { base64ToBytes } from '../../util/base64';
import { uuidv4 } from '../../util/uuid';

/** Reads this device's own cached, server-signed credential (M3 Milestone
 * 3 -- see fetchAndCacheOwnCredential's doc comment, crypto/identity.ts) to
 * embed into a SessionHello. Throws with a clear, actionable message if
 * none is cached -- a rare, first-run-only edge (enrollment itself requires
 * being online, so this only happens if the device has never gone online
 * since) -- callers already fail-open to the QR fallback on any throw here. */
async function requireOwnCredentialCose(deviceId: string): Promise<Uint8Array> {
  const cached = await getCachedOwnCredential(deviceId);
  if (!cached) {
    throw new Error('no cached own device credential -- go online at least once after enrolling before using BLE');
  }
  return base64ToBytes(cached);
}

/**
 * M3 Milestone 2: the BLE analogue of what `paymentFlow.ts` already does for
 * QR-carried bytes -- establish an authenticated session with a peer (this
 * time over the real GATT transport, `BleGattTransport.kt` via
 * `native/TapPayNative.ts`), then send/receive sealed application messages.
 * `packages/shared/src/crypto/session.ts` and `sessionTransport.ts` do all
 * the actual crypto; this module's only job is sequencing the hello exchange
 * over a real byte stream and wiring in the send-counter/replay-window state
 * those two modules deliberately leave to "the transport layer."
 *
 * Both establish functions throw on any failure -- never return a degraded
 * or unauthenticated session, matching `deriveSessionKey`'s own fail-closed
 * contract. Callers (PayScreen.tsx, Milestone 2 Phase D) catch and fall back
 * to the existing QR flow; this module never fakes success.
 */

export interface BleSession {
  ourDeviceId: string;
  peerDeviceId: string;
  /** Seals `plaintext` and sends it over the active BLE connection. */
  send(plaintext: Uint8Array): Promise<void>;
  /** Registers a listener for opened, replay-checked plaintext messages.
   * Returns an unsubscribe function. */
  onMessage(listener: (plaintext: Uint8Array) => void): () => void;
  /** Tears down the BLE connection and stops advertising/scanning. */
  close(): void;
}

/** Default budget for the whole establish flow (connect/advertise-wait +
 * hello exchange), not just the initial radio connection -- config-driven
 * per call site, not a hardcoded assumption baked into this module.
 *
 * 15s (the original value) measurably failed live on real hardware: the
 * PERIPHERAL side's "wait for a central to connect" phase is bounded by how
 * long it takes the OTHER human/flow to get there, not by radio speed --
 * `dumpsys bluetooth_manager` showed the advertisement starting and this
 * function's own timeout tearing it back down (via bleDisconnect() ->
 * stopAdvertising()) a full 15016ms later, well before the paired phone's
 * operator had even switched screens to start the connect side. The eventual
 * PayScreen wiring (Milestone 2 Phase D) has the exact same shape: the
 * receiver starts advertising right after "Request payment," but the sender
 * only calls connectAndEstablishSession after scanning the Request QR --
 * itself an unbounded-by-radio, human-paced step. 15s was never going to
 * survive that either. */
const DEFAULT_ESTABLISH_TIMEOUT_MS = 90_000;

/** Grace period after a proactive `bleDisconnect()` before registering a new
 * attempt's listeners -- found necessary via live two-phone testing.
 * `BleGattTransport.kt`'s connection-state callback is a single mutable
 * field on the native singleton, not scoped per attempt, and Android's own
 * BLE disconnect confirmation (`onConnectionStateChange(STATE_DISCONNECTED)`)
 * is asynchronous and can genuinely arrive tens of seconds after
 * `disconnect()` is called (a documented real-world Android BLE quirk, not
 * a bug in this codebase). Observed directly: a session left open after a
 * settled transaction (nothing was closing it) had its stale disconnect
 * confirmation arrive 22 SECONDS after a brand new advertiseAndAwaitSession
 * call had already registered its own listener -- that late event was
 * misread as "the new attempt's peer disconnected," killing it instantly
 * even though nothing had connected to it yet. Calling bleDisconnect()
 * proactively at the START of every attempt (idempotent, safe even if
 * nothing is connected) and waiting this long afterward doesn't eliminate
 * the underlying race -- only a per-attempt generation token threaded
 * through the native event payload would do that structurally -- but it
 * closes the specific, demonstrated failure mode of leftover state from a
 * PRIOR attempt bleeding into a fresh one started shortly after. */
const POST_DISCONNECT_SETTLE_MS = 1500;

async function resetNativeBleState(): Promise<void> {
  await bleDisconnect();
  await new Promise((resolve) => setTimeout(resolve, POST_DISCONNECT_SETTLE_MS));
}

function waitForConnectionState(target: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let subscription: EventSubscription | null = null;
    const timer = setTimeout(() => {
      subscription?.remove();
      reject(new Error(`timed out waiting for BLE state "${target}"`));
    }, timeoutMs);
    subscription = onBleTransportConnectionState(({ state }) => {
      if (state === target) {
        clearTimeout(timer);
        subscription?.remove();
        resolve();
      }
    });
  });
}

/** Multiplexes the single `onBleTransportData` event stream: during the
 * hello handshake, `waitForNext` resolves the next inbound message as a
 * one-shot promise; once a session is established, `setFallbackHandler`
 * redirects every subsequent message to the BleSession's own listeners.
 * There is exactly one native event stream per connection, so this ordering
 * (handshake messages first, application messages after) is a real protocol
 * convention this module enforces, not an incidental implementation detail. */
function createMessageWaiter() {
  let pendingResolve: ((data: Uint8Array) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;
  let fallbackHandler: ((data: Uint8Array) => void) | null = null;

  const subscription = onBleTransportData(({ data }) => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      resolve(data);
    } else {
      fallbackHandler?.(data);
    }
  });

  return {
    waitForNext(timeoutMs: number): Promise<Uint8Array> {
      return new Promise<Uint8Array>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
        setTimeout(() => {
          if (pendingReject === reject) {
            pendingResolve = null;
            pendingReject = null;
            reject(new Error('timed out waiting for a BLE message'));
          }
        }, timeoutMs);
      });
    },
    setFallbackHandler(handler: (data: Uint8Array) => void) {
      fallbackHandler = handler;
    },
    dispose() {
      subscription.remove();
    },
  };
}

/** Rejects `promise` early if a "disconnected" event fires first -- without
 * this, a peer that drops mid-handshake would otherwise just hang until the
 * handshake step's own timeout, rather than failing immediately. */
function raceDisconnection<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const subscription = onBleTransportConnectionState(({ state }) => {
      if (state === 'disconnected') {
        subscription.remove();
        reject(new Error('BLE peer disconnected before the session was established'));
      }
    });
    promise.then(
      (value) => {
        subscription.remove();
        resolve(value);
      },
      (err) => {
        subscription.remove();
        reject(err);
      },
    );
  });
}

/** `buildNonce`'s encoding (session.ts, not exported): nonce[0] = direction,
 * nonce[1..11] = big-endian counter. The nonce is the unencrypted prefix of
 * every sealed message (`sealed.slice(0, 12)`), so the counter can be read
 * directly off the wire before ever attempting to open the message --
 * exactly the same public-nonce convention AES-GCM itself relies on. */
function extractCounterFromSealed(sealed: Uint8Array): bigint {
  let counter = 0n;
  for (let i = 1; i <= 11; i++) {
    counter = (counter << 8n) | BigInt(sealed[i] ?? 0);
  }
  return counter;
}

function makeSession(sessionKey: Uint8Array, ourDeviceId: string, peerDeviceId: string, waiter: ReturnType<typeof createMessageWaiter>): BleSession {
  const counters = createSessionCounterState();
  const listeners = new Set<(plaintext: Uint8Array) => void>();

  waiter.setFallbackHandler((sealed) => {
    // Verify BEFORE touching the replay window: a forged/corrupted packet
    // must never be able to "burn" a legitimate future counter slot. Only a
    // message that actually decrypts+authenticates gets to consume a
    // position in the window.
    const opened = openSessionMessage(sessionKey, uuidToBytes(ourDeviceId), uuidToBytes(peerDeviceId), sealed);
    if (!opened) return; // fail closed, same discipline as session.ts itself -- drop silently
    const counter = extractCounterFromSealed(sealed);
    if (!acceptReceivedCounter(counters, counter)) return; // already delivered -- drop
    for (const listener of listeners) listener(opened);
  });

  return {
    ourDeviceId,
    peerDeviceId,
    async send(plaintext: Uint8Array) {
      const counter = nextSendCounter(counters);
      const sealed = sealSessionMessage(sessionKey, uuidToBytes(ourDeviceId), uuidToBytes(peerDeviceId), counter, plaintext);
      await bleSend(sealed);
    },
    onMessage(listener: (plaintext: Uint8Array) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      waiter.dispose();
      void bleDisconnect();
    },
  };
}

/**
 * Peripheral role (RECEIVE side): advertises `identity.deviceId`, waits for
 * a central to connect, then waits for the CENTRAL's hello (the initiator
 * always speaks first -- it minted the session `tx_uuid` and has nothing
 * else to wait on), adopts that `tx_uuid`, signs and sends our own hello
 * back, and derives the session key.
 */
export async function advertiseAndAwaitSession(identity: EnrolledIdentity, timeoutMs = DEFAULT_ESTABLISH_TIMEOUT_MS): Promise<BleSession> {
  const waiter = createMessageWaiter();
  try {
    // See POST_DISCONNECT_SETTLE_MS's doc comment -- clears any leftover
    // native state from a prior attempt before this one registers its own
    // listeners, closing the specific stale-disconnect race found live.
    await resetNativeBleState();
    await bleStartAdvertising(uuidToBytes(identity.deviceId));
    await raceDisconnection(waitForConnectionState('connected', timeoutMs));

    const peerHelloCose = await raceDisconnection(waiter.waitForNext(timeoutMs));
    // Read routing metadata WITHOUT trusting it yet -- same "read kid, then
    // verify" pattern SessionDemoScreen.tsx already established. Nothing
    // from this unverified decode is used to derive the session key below.
    const unverifiedHello = decodeSessionHello(decodeCoseSign1Unverified(peerHelloCose).payload);
    const txUuid = unverifiedHello.tx_uuid;
    const peerDeviceId = bytesToUuid(unverifiedHello.device_id);

    // Hermes has no global crypto.getRandomValues -- expo-crypto's real
    // native RNG must be passed explicitly (session.ts's own doc comment;
    // SessionDemoScreen.tsx hit this the hard way first).
    const eph = generateEphemeralKeyPair(Crypto.getRandomBytes);
    const ourHelloCose = await createSessionHello({
      txUuid,
      deviceId: uuidToBytes(identity.deviceId),
      ephPublicKey: eph.publicKey,
      sign: createIdentitySigner(identity.deviceId),
      ownCredentialCose: await requireOwnCredentialCose(identity.deviceId),
    });
    await bleSend(ourHelloCose);

    // M3 Milestone 3: the peer's identity_pubkey is no longer fetched live --
    // it's extracted from `peerHelloCose`'s own embedded credential and
    // verified against the pinned server key, entirely offline. See
    // deriveSessionKey/verifyEmbeddedCredential (packages/shared/src/crypto/
    // session.ts) for the actual verification order.
    const key = deriveSessionKey({
      txUuid,
      ourDeviceId: uuidToBytes(identity.deviceId),
      ourEphSecretKey: eph.secretKey,
      ourEphPublicKey: eph.publicKey,
      peerHelloCose,
      serverPublicKey: getServerPublicKeyBytes(),
    });
    if (!key) {
      throw new Error('BLE session derivation failed -- see deriveSessionKey (fails closed with no further detail by design)');
    }
    return makeSession(key, identity.deviceId, peerDeviceId, waiter);
  } catch (err) {
    waiter.dispose();
    void bleDisconnect();
    throw err;
  }
}

/** An established BLE radio link (central/SEND role), not yet
 * cryptographically authenticated -- the handshake (ephemeral keygen +
 * signing + peer verification) hasn't happened yet. See connectBleRadio's
 * doc comment for why this is a separate step from completeBleHandshake
 * (M3 Milestone 3's single-biometric-prompt work). */
export interface BleRadioConnection {
  waiter: ReturnType<typeof createMessageWaiter>;
  targetDeviceId: Uint8Array;
  timeoutMs: number;
}

/** Tears down a `BleRadioConnection` that never made it to
 * `completeBleHandshake` (e.g. the user reset the flow, or switched roles,
 * before tapping "Sign") -- without this, the radio link + waiter
 * subscription from `connectBleRadio` would leak. Safe to call on an
 * already-torn-down connection. */
export function closeBleRadioConnection(connection: BleRadioConnection): void {
  connection.waiter.dispose();
  void bleDisconnect();
}

/**
 * Central role (SEND side), radio-only: connects to the peer advertising
 * `targetDeviceId` (the same `recipient_device_id` already scanned from the
 * Request QR -- no separate BLE pairing QR). Does NOT sign anything -- no
 * ephemeral key, no SessionHello -- so it triggers no biometric prompt.
 * Split out from what used to be one combined `connectAndEstablishSession`
 * specifically so a caller (PayScreen.tsx) can start this the moment a
 * Request QR is scanned (well before the user has even entered an amount),
 * and defer the actual signing (completeBleHandshake) until the user taps
 * "Sign" -- at which point it runs back-to-back with the payment proposal's
 * own sign call, within the same KeyStore auth-validity window
 * (KeyStoreManager.kt), so the user sees exactly one biometric prompt
 * instead of two for what is, from their perspective, one action.
 */
export async function connectBleRadio(targetDeviceId: Uint8Array, timeoutMs = DEFAULT_ESTABLISH_TIMEOUT_MS): Promise<BleRadioConnection> {
  const waiter = createMessageWaiter();
  try {
    // See POST_DISCONNECT_SETTLE_MS's doc comment -- same stale-state
    // clearing as advertiseAndAwaitSession, for the central role.
    await resetNativeBleState();
    await bleConnectToPeer(targetDeviceId, timeoutMs);
    return { waiter, targetDeviceId, timeoutMs };
  } catch (err) {
    waiter.dispose();
    void bleDisconnect();
    throw err;
  }
}

/**
 * Central role (SEND side), handshake phase: mints a fresh session
 * `tx_uuid`, signs and sends our hello first (we're the initiator -- this
 * is the sign call a caller should trigger right before/alongside its own
 * payment-proposal sign, see connectBleRadio's doc comment), waits for the
 * peer's hello back, and derives the session key. Takes the
 * `BleRadioConnection` `connectBleRadio` already established.
 */
export async function completeBleHandshake(identity: EnrolledIdentity, connection: BleRadioConnection): Promise<BleSession> {
  const { waiter, targetDeviceId, timeoutMs } = connection;
  try {
    const txUuid = uuidToBytes(uuidv4());
    const eph = generateEphemeralKeyPair(Crypto.getRandomBytes);
    const ourHelloCose = await createSessionHello({
      txUuid,
      deviceId: uuidToBytes(identity.deviceId),
      ephPublicKey: eph.publicKey,
      sign: createIdentitySigner(identity.deviceId),
      ownCredentialCose: await requireOwnCredentialCose(identity.deviceId),
    });
    await bleSend(ourHelloCose);

    const peerHelloCose = await raceDisconnection(waiter.waitForNext(timeoutMs));
    const unverifiedHello = decodeSessionHello(decodeCoseSign1Unverified(peerHelloCose).payload);
    const peerDeviceId = bytesToUuid(unverifiedHello.device_id);
    // Sanity check against the BLE scan-filter target -- not the actual
    // security boundary (that's deriveSessionKey's embedded-credential check
    // below), just an early, clear failure if the radio somehow connected us
    // to the wrong advertiser.
    if (peerDeviceId !== bytesToUuid(targetDeviceId)) {
      throw new Error('connected BLE peer does not match the target device -- aborting');
    }

    // M3 Milestone 3: see advertiseAndAwaitSession's matching comment -- the
    // peer's identity_pubkey comes from its own embedded credential now, not
    // a live fetch.
    const key = deriveSessionKey({
      txUuid,
      ourDeviceId: uuidToBytes(identity.deviceId),
      ourEphSecretKey: eph.secretKey,
      ourEphPublicKey: eph.publicKey,
      peerHelloCose,
      serverPublicKey: getServerPublicKeyBytes(),
    });
    if (!key) {
      throw new Error('BLE session derivation failed -- see deriveSessionKey (fails closed with no further detail by design)');
    }
    return makeSession(key, identity.deviceId, peerDeviceId, waiter);
  } catch (err) {
    waiter.dispose();
    void bleDisconnect();
    throw err;
  }
}

/**
 * Central role (SEND side), combined: `connectBleRadio` immediately followed
 * by `completeBleHandshake`, for callers that don't need the single-prompt
 * split (e.g. BleDemoScreen.tsx's standalone connectivity check) -- one
 * biometric prompt either way, just not deferred to a later user action.
 */
export async function connectAndEstablishSession(
  identity: EnrolledIdentity,
  targetDeviceId: Uint8Array,
  timeoutMs = DEFAULT_ESTABLISH_TIMEOUT_MS,
): Promise<BleSession> {
  const connection = await connectBleRadio(targetDeviceId, timeoutMs);
  return completeBleHandshake(identity, connection);
}
