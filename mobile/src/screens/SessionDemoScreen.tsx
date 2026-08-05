import {
  bytesToUuid,
  createSessionHello,
  decodeCoseSign1Unverified,
  decodeSessionHello,
  deriveSessionKey,
  generateEphemeralKeyPair,
  openSessionMessage,
  sealSessionMessage,
  uuidToBytes,
  type EphemeralKeyPair,
} from '@tappay/shared';
import * as Crypto from 'expo-crypto';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { QrWithCopyableText, ScanStep } from '../components/qrFlow';
import { createIdentitySigner, enrollDevice, fetchPeerCredential, type EnrolledIdentity } from '../crypto/identity';
import { bytesToQrString, qrStringToBytes } from '../transport/qr';
import { uuidv4 } from '../util/uuid';

/**
 * On-device proof of packages/shared/src/crypto/session.ts (Phase 6's
 * authenticated ECDH layer) -- not a new protocol, not part of M3 (no GATT
 * transport exists yet to wire this into). Three things this layer had NEVER
 * exercised on real hardware before this screen: createSessionHello's
 * biometric-gated signing call, fetchPeerCredential's real HTTP round trip +
 * verification, and deriveSessionKey's ECDH/HKDF/AES-GCM math actually
 * running on Hermes rather than Node under vitest.
 *
 * Originally built under the one-phone constraint shared with M1's TapScreen
 * and M2's OfflineScreen: both identities enrolled in the same app session,
 * relayed via the existing QR/paste transport (bytesToQrString/
 * qrStringToBytes) -- proving the wire encoding too, not just calling the
 * functions in-process. Both sides are still rendered simultaneously and
 * permanently (unlike TapScreen's role-toggle, which resets state on
 * switch) so each side's ephemeral secret key survives the whole flow.
 *
 * Now also runs across two genuinely separate phones: each side's peer info
 * (device_id, session tx_uuid) is only ever read from LOCAL state
 * (peer.identity / sessionTxUuid) when the other identity really is enrolled
 * in this same process. Otherwise -- the two-phone case, where only one
 * side's identity is ever enrolled per phone -- both are instead learned
 * from the peer's own scanned Hello (decodeCoseSign1Unverified +
 * decodeSessionHello read the untrusted routing fields, same "read kid, then
 * verify" pattern used elsewhere in this codebase). This does not weaken
 * authentication: fetchPeerCredential still re-verifies that learned
 * device_id against the server-signed credential before any shared secret is
 * derived, exactly as it already did for the locally-known case -- this only
 * removes the requirement that both identities live in one process, the same
 * thing BLE discovery would tell a real device before a handshake starts.
 */

type Side = 'alice' | 'bob';

function otherSide(side: Side): Side {
  return side === 'alice' ? 'bob' : 'alice';
}

interface SideState {
  email: string;
  identity: EnrolledIdentity | null;
  enrolling: boolean;
  eph: EphemeralKeyPair | null;
  helloQr: string | null;
  /** The peer's device_id, learned from their scanned Hello when the peer
   * isn't enrolled in THIS process (the real two-phone case) -- see
   * effectivePeerDeviceId below. Unused, and unnecessary, when peer.identity
   * is locally known (one-phone testing). */
  remotePeerDeviceId: string | null;
  sessionKey: Uint8Array | null;
  messageInput: string;
  sealedQr: string | null;
  openedMessage: string | null;
  error: string | null;
}

function initialSideState(email: string): SideState {
  return {
    email,
    identity: null,
    enrolling: false,
    eph: null,
    helloQr: null,
    remotePeerDeviceId: null,
    sessionKey: null,
    messageInput: 'hello from the other side',
    sealedQr: null,
    openedMessage: null,
    error: null,
  };
}

/** The peer's device_id for seal/open direction and credential lookup:
 * prefer the peer's real local identity when it's enrolled in this same
 * process (one-phone testing), else fall back to what was learned from their
 * scanned Hello (two-phone case). */
function effectivePeerDeviceId(own: SideState, peer: SideState): string | null {
  return peer.identity?.deviceId ?? own.remotePeerDeviceId;
}

// A human copy-pasting a QR string between two panels on one phone routinely
// takes longer than the library's 30s production default (session.ts's
// DEFAULT_SESSION_HELLO_WINDOW_MS) -- that default is correct for a real bump
// exchange, not for this demo's UX. Passed explicitly, not a change to the
// library.
const DEMO_HELLO_WINDOW_MS = 30 * 60_000;

// Hermes global TextEncoder/TextDecoder support isn't asserted anywhere else
// in this codebase (mobile/src/util/base64.ts hand-rolls base64 for the same
// underlying reason: don't assume a global exists). A minimal ASCII-only
// codec sidesteps the question entirely -- fine for this demo's plaintext
// message field, not a general-purpose text utility.
function asciiToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}
function bytesToAscii(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}
function shortHex(bytes: Uint8Array, len = 8): string {
  return Array.from(bytes.slice(0, len))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export default function SessionDemoScreen() {
  const [sessionTxUuid, setSessionTxUuid] = useState<string | null>(null);
  const [sides, setSides] = useState<Record<Side, SideState>>({
    alice: initialSideState('alice@tappay.local'),
    bob: initialSideState('bob@tappay.local'),
  });

  const patchSide = useCallback((side: Side, patch: Partial<SideState>) => {
    setSides((prev) => ({ ...prev, [side]: { ...prev[side], ...patch } }));
  }, []);

  const handleEnroll = useCallback(
    async (side: Side) => {
      patchSide(side, { enrolling: true, error: null });
      try {
        const identity = await enrollDevice(sides[side].email);
        patchSide(side, { identity, enrolling: false });
      } catch (err) {
        patchSide(side, { error: String(err), enrolling: false });
      }
    },
    [patchSide, sides],
  );

  const anyEnrolled = sides.alice.identity !== null || sides.bob.identity !== null;

  const handleNewSession = useCallback(() => {
    setSessionTxUuid(uuidv4());
    // A new session invalidates any prior key material, but not enrollment.
    setSides((prev) => ({
      alice: {
        ...prev.alice,
        eph: null,
        helloQr: null,
        remotePeerDeviceId: null,
        sessionKey: null,
        sealedQr: null,
        openedMessage: null,
        error: null,
      },
      bob: {
        ...prev.bob,
        eph: null,
        helloQr: null,
        remotePeerDeviceId: null,
        sessionKey: null,
        sealedQr: null,
        openedMessage: null,
        error: null,
      },
    }));
  }, []);

  const handleSignHello = useCallback(
    async (side: Side) => {
      const own = sides[side];
      if (!own.identity || !sessionTxUuid) return;
      patchSide(side, { error: null });
      try {
        // Reuse an already-generated ephemeral key if one exists (the
        // two-phone responder path generates it while deriving the session
        // key from the peer's Hello, BEFORE ever calling this function --
        // signing a hello with a different eph key than the one used for
        // ECDH would silently desync the two sides). Only mint a fresh one
        // for the normal initiator path, where this is the first action.
        //
        // @noble/curves' default RNG needs globalThis.crypto.getRandomValues,
        // which Hermes doesn't provide -- pass expo-crypto's real native RNG
        // explicitly, the same primitive TapScreen.tsx already uses for its
        // receiver nonce. Found the hard way: this screen's whole purpose is
        // catching exactly this kind of on-device-only gap.
        const eph = own.eph ?? generateEphemeralKeyPair(Crypto.getRandomBytes);
        // Shows the system biometric prompt (KeyStoreManager.sign), same
        // signer every other signing path in this app uses.
        const helloCose = await createSessionHello({
          txUuid: uuidToBytes(sessionTxUuid),
          deviceId: uuidToBytes(own.identity.deviceId),
          ephPublicKey: eph.publicKey,
          sign: createIdentitySigner(own.identity.deviceId),
        });
        patchSide(side, { eph, helloQr: bytesToQrString(helloCose) });
      } catch (err) {
        patchSide(side, { error: String(err) });
      }
    },
    [sides, sessionTxUuid, patchSide],
  );

  const handlePeerHelloScanned = useCallback(
    async (side: Side, data: string) => {
      const own = sides[side];
      const peer = sides[otherSide(side)];
      if (!own.identity) return;
      patchSide(side, { error: null });
      try {
        const peerHelloCose = qrStringToBytes(data);
        // Read routing metadata WITHOUT trusting it yet -- same "read kid,
        // then verify" pattern as TxProposal's sender_device_id elsewhere in
        // this codebase. Nothing from this unverified decode is used to
        // derive the session key below; it only tells us which tx_uuid to
        // adopt (if we don't have one yet -- the two-phone responder case)
        // and which device to ask the SERVER about.
        const unverifiedHello = decodeSessionHello(decodeCoseSign1Unverified(peerHelloCose).payload);
        const helloTxUuid = bytesToUuid(unverifiedHello.tx_uuid);

        let txUuid = sessionTxUuid;
        if (!txUuid) {
          // No local session yet -- this side is responding to a peer we
          // haven't enrolled locally (two real phones), so adopt the tx_uuid
          // the initiator's Hello actually carries rather than minting our
          // own mismatched one.
          txUuid = helloTxUuid;
          setSessionTxUuid(txUuid);
        } else if (txUuid !== helloTxUuid) {
          throw new Error("this Hello is for a different session (tx_uuid mismatch) -- start a new session on both sides");
        }

        // Own ephemeral key: reuse it if we already signed our own Hello
        // first (one-phone testing order), else generate it now -- the
        // two-phone responder scans before signing, since it has no tx_uuid
        // to sign a Hello with until this point. See handleSignHello's
        // matching reuse-if-present logic; both must agree on the same key.
        const eph = own.eph ?? generateEphemeralKeyPair(Crypto.getRandomBytes);

        // The peer's REAL enrolled identity_pubkey, verified server-side --
        // never trust-on-first-use from the pasted hello itself. Prefer the
        // peer's real local identity when it's enrolled in this same process
        // (one-phone testing); otherwise ask about the device_id the peer's
        // own Hello claims to be from -- fetchPeerCredential re-verifies
        // that claim against the server-signed credential before trusting
        // it, so this doesn't weaken authentication, it only removes the
        // requirement that both identities live in one process.
        const peerDeviceId = peer.identity?.deviceId ?? bytesToUuid(unverifiedHello.device_id);
        const credential = await fetchPeerCredential(peerDeviceId);
        if (!credential) {
          throw new Error('could not fetch/verify the peer device credential -- is the server reachable, and is the peer really enrolled?');
        }
        const key = deriveSessionKey({
          txUuid: uuidToBytes(txUuid),
          ourDeviceId: uuidToBytes(own.identity.deviceId),
          ourEphSecretKey: eph.secretKey,
          ourEphPublicKey: eph.publicKey,
          peerHelloCose,
          peerIdentityPubkey: credential.identity_pubkey,
          helloWindowMs: DEMO_HELLO_WINDOW_MS,
        });
        if (!key) {
          // deriveSessionKey returns null on ANY failure with no reason, by
          // design (fail closed) -- this covers the demo's likely causes.
          throw new Error(
            'session derivation failed -- check the pasted Hello is for this session and really from the other side (not pasted back at itself)',
          );
        }
        patchSide(side, { eph, remotePeerDeviceId: peerDeviceId, sessionKey: key });
      } catch (err) {
        patchSide(side, { error: String(err) });
      }
    },
    [sides, sessionTxUuid, patchSide],
  );

  const handleSealMessage = useCallback(
    (side: Side) => {
      const own = sides[side];
      const peer = sides[otherSide(side)];
      const peerDeviceId = effectivePeerDeviceId(own, peer);
      if (!own.identity || !own.sessionKey || !peerDeviceId) return;
      patchSide(side, { error: null });
      try {
        const sealed = sealSessionMessage(
          own.sessionKey,
          uuidToBytes(own.identity.deviceId),
          uuidToBytes(peerDeviceId),
          0n,
          asciiToBytes(own.messageInput),
        );
        patchSide(side, { sealedQr: bytesToQrString(sealed) });
      } catch (err) {
        patchSide(side, { error: String(err) });
      }
    },
    [sides, patchSide],
  );

  const handleOpenMessage = useCallback(
    (side: Side, data: string) => {
      const own = sides[side];
      const peer = sides[otherSide(side)];
      const peerDeviceId = effectivePeerDeviceId(own, peer);
      if (!own.identity || !own.sessionKey || !peerDeviceId) return;
      patchSide(side, { error: null });
      try {
        const sealedBytes = qrStringToBytes(data);
        const opened = openSessionMessage(own.sessionKey, uuidToBytes(own.identity.deviceId), uuidToBytes(peerDeviceId), sealedBytes);
        if (!opened) {
          throw new Error('failed to open -- wrong key, tampered message, or wrong direction (pasted your own sealed message back at yourself?)');
        }
        patchSide(side, { openedMessage: bytesToAscii(opened) });
      } catch (err) {
        patchSide(side, { error: String(err) });
      }
    },
    [sides, patchSide],
  );

  const renderSide = (side: Side) => {
    const own = sides[side];
    const peer = sides[otherSide(side)];
    const label = side === 'alice' ? 'Device A (Alice)' : 'Device B (Bob)';
    const peerLabel = side === 'alice' ? "Bob's" : "Alice's";

    return (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>{label}</Text>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Email</Text>
          <TextInput
            style={styles.input}
            value={own.email}
            onChangeText={(text) => patchSide(side, { email: text })}
            editable={!own.identity}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {!own.identity && (
            <TouchableOpacity style={styles.smallButton} onPress={() => void handleEnroll(side)} disabled={own.enrolling}>
              <Text style={styles.smallButtonText}>{own.enrolling ? 'Enrolling…' : 'Enroll'}</Text>
            </TouchableOpacity>
          )}
        </View>

        {own.identity && (
          <View style={styles.readout}>
            <Text style={styles.readoutText}>device: {own.identity.deviceId.slice(0, 8)}</Text>
            <Text style={styles.readoutText}>StrongBox: {own.identity.strongBoxBacked ? 'yes' : 'no (TEE fallback)'}</Text>
          </View>
        )}

        {own.error && <Text style={styles.error}>{own.error}</Text>}

        {own.identity && (
          <>
            {sessionTxUuid && !own.helloQr && (
              <TouchableOpacity style={styles.button} onPress={() => void handleSignHello(side)}>
                <Text style={styles.buttonText}>Sign & show Hello (biometric prompt)</Text>
              </TouchableOpacity>
            )}
            {own.helloQr && <QrWithCopyableText value={own.helloQr} />}

            {/* Available even before a local session/Hello exists: the
                two-phone responder scans the initiator's Hello first, and
                adopts its tx_uuid + peer device_id from it (see
                handlePeerHelloScanned). One-phone testing still works in the
                original order (sign, then scan) since it only reads this
                once own.helloQr is already set below anyway. */}
            {!own.sessionKey && (
              <ScanStep label={`Paste ${peerLabel} Hello`} onManualSubmit={(data) => void handlePeerHelloScanned(side, data)} />
            )}

            {own.sessionKey && (
              <View style={styles.readout}>
                <Text style={styles.readoutText}>session key derived: {shortHex(own.sessionKey)}…</Text>
              </View>
            )}

            {own.sessionKey && effectivePeerDeviceId(own, peer) && (
              <View style={styles.section}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Message</Text>
                  <TextInput
                    style={styles.input}
                    value={own.messageInput}
                    onChangeText={(text) => patchSide(side, { messageInput: text })}
                  />
                  <TouchableOpacity style={styles.smallButton} onPress={() => handleSealMessage(side)}>
                    <Text style={styles.smallButtonText}>Seal & show</Text>
                  </TouchableOpacity>
                </View>
                {own.sealedQr && <QrWithCopyableText value={own.sealedQr} />}
                <ScanStep label={`Paste ${peerLabel} sealed message`} onManualSubmit={(data) => handleOpenMessage(side, data)} />
                {own.openedMessage !== null && <Text style={styles.settledText}>opened: "{own.openedMessage}"</Text>}
              </View>
            )}
          </>
        )}
      </View>
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Authenticated Session ECDH (M3 preview)</Text>
      <Text style={styles.subtitle}>
        Exchanges real signed Hellos and derives a real session key over the real network -- proving
        packages/shared/src/crypto/session.ts on real hardware. Works with both identities enrolled on this one phone,
        or with only one enrolled here and the other on a second physical phone (scan its Hello below to join its
        session instead of pressing "Start session"). Not wired into any transport yet; that's M3's GATT layer.
      </Text>

      {anyEnrolled && (
        <TouchableOpacity style={styles.button} onPress={handleNewSession}>
          <Text style={styles.buttonText}>{sessionTxUuid ? 'New session' : 'Start session'}</Text>
        </TouchableOpacity>
      )}
      {sessionTxUuid && <Text style={styles.readoutText}>tx_uuid: {sessionTxUuid.slice(0, 8)}…</Text>}

      {renderSide('alice')}
      {renderSide('bob')}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  content: { padding: 16, gap: 12 },
  title: { color: '#eee', fontSize: 18, fontWeight: '600' },
  subtitle: { color: '#888', fontSize: 12, marginBottom: 8 },
  panel: { gap: 10, padding: 12, backgroundColor: '#181818', borderRadius: 10, borderWidth: 1, borderColor: '#2a2a2a' },
  panelTitle: { color: '#eee', fontWeight: '700', fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowLabel: { color: '#aaa', width: 140 },
  input: {
    flex: 1,
    minWidth: 120,
    backgroundColor: '#1b1b1b',
    color: '#eee',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#333',
  },
  smallButton: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#2a2a2a', borderRadius: 6 },
  smallButtonText: { color: '#eee' },
  error: { color: '#ff6b6b' },
  readout: { padding: 12, backgroundColor: '#1b1b1b', borderRadius: 8, gap: 4 },
  readoutText: { color: '#ccc', fontFamily: 'monospace' },
  button: { backgroundColor: '#4ea8ff', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#111', fontWeight: '700', fontSize: 15 },
  section: { gap: 8 },
  settledText: { color: '#4eff8a', fontWeight: '700', fontSize: 15 },
});
