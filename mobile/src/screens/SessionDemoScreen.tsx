import {
  createSessionHello,
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
 * Same one-phone constraint as M1's TapScreen and M2's OfflineScreen: with
 * only one physical device available, both sides of this two-party exchange
 * are enrolled in the same app session and relayed via the existing QR/paste
 * transport (bytesToQrString/qrStringToBytes) -- proving the wire encoding
 * too, not just calling the functions in-process. Unlike TapScreen's
 * role-toggle (which resets state on switch), BOTH sides are rendered here
 * simultaneously and permanently: an ECDH exchange needs each side's
 * ephemeral secret key to survive for the whole flow, which a
 * mount/unmount-on-toggle pattern would destroy.
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
    sessionKey: null,
    messageInput: 'hello from the other side',
    sealedQr: null,
    openedMessage: null,
    error: null,
  };
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

  const bothEnrolled = sides.alice.identity !== null && sides.bob.identity !== null;

  const handleNewSession = useCallback(() => {
    setSessionTxUuid(uuidv4());
    // A new session invalidates any prior key material, but not enrollment.
    setSides((prev) => ({
      alice: { ...prev.alice, eph: null, helloQr: null, sessionKey: null, sealedQr: null, openedMessage: null, error: null },
      bob: { ...prev.bob, eph: null, helloQr: null, sessionKey: null, sealedQr: null, openedMessage: null, error: null },
    }));
  }, []);

  const handleSignHello = useCallback(
    async (side: Side) => {
      const own = sides[side];
      if (!own.identity || !sessionTxUuid) return;
      patchSide(side, { error: null });
      try {
        // @noble/curves' default RNG needs globalThis.crypto.getRandomValues,
        // which Hermes doesn't provide -- pass expo-crypto's real native RNG
        // explicitly, the same primitive TapScreen.tsx already uses for its
        // receiver nonce. Found the hard way: this screen's whole purpose is
        // catching exactly this kind of on-device-only gap.
        const eph = generateEphemeralKeyPair(Crypto.getRandomBytes);
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
      if (!own.identity || !own.eph || !peer.identity || !sessionTxUuid) return;
      patchSide(side, { error: null });
      try {
        const peerHelloCose = qrStringToBytes(data);
        // The peer's REAL enrolled identity_pubkey, verified server-side --
        // never trust-on-first-use from the pasted hello itself. The parent
        // already knows peer.identity.deviceId (both identities live in this
        // one screen), mirroring how a real BLE flow already knows which
        // device it's talking to from discovery, before the ECDH handshake.
        const credential = await fetchPeerCredential(peer.identity.deviceId);
        if (!credential) {
          throw new Error('could not fetch/verify the peer device credential -- is the server reachable, and is the peer really enrolled?');
        }
        const key = deriveSessionKey({
          txUuid: uuidToBytes(sessionTxUuid),
          ourDeviceId: uuidToBytes(own.identity.deviceId),
          ourEphSecretKey: own.eph.secretKey,
          ourEphPublicKey: own.eph.publicKey,
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
        patchSide(side, { sessionKey: key });
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
      if (!own.identity || !own.sessionKey || !peer.identity) return;
      patchSide(side, { error: null });
      try {
        const sealed = sealSessionMessage(
          own.sessionKey,
          uuidToBytes(own.identity.deviceId),
          uuidToBytes(peer.identity.deviceId),
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
      if (!own.identity || !own.sessionKey || !peer.identity) return;
      patchSide(side, { error: null });
      try {
        const sealedBytes = qrStringToBytes(data);
        const opened = openSessionMessage(own.sessionKey, uuidToBytes(own.identity.deviceId), uuidToBytes(peer.identity.deviceId), sealedBytes);
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

        {own.identity && sessionTxUuid && (
          <>
            {!own.helloQr && (
              <TouchableOpacity style={styles.button} onPress={() => void handleSignHello(side)}>
                <Text style={styles.buttonText}>Sign & show Hello (biometric prompt)</Text>
              </TouchableOpacity>
            )}
            {own.helloQr && <QrWithCopyableText value={own.helloQr} />}

            {own.helloQr && !own.sessionKey && (
              <ScanStep label={`Paste ${peerLabel} Hello`} onManualSubmit={(data) => void handlePeerHelloScanned(side, data)} />
            )}

            {own.sessionKey && (
              <View style={styles.readout}>
                <Text style={styles.readoutText}>session key derived: {shortHex(own.sessionKey)}…</Text>
              </View>
            )}

            {own.sessionKey && peer.identity && (
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
        Two identities enrolled on this one phone, exchanging real signed Hellos and deriving a real session key -- proving
        packages/shared/src/crypto/session.ts on real hardware. Not wired into any transport yet; that's M3's GATT layer.
      </Text>

      {bothEnrolled && (
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
