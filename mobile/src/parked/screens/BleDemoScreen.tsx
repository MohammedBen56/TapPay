import { uuidToBytes } from '@tappay/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { enrollDevice, type EnrolledIdentity } from '../crypto/identity';
import { onBleTransportConnectionState, requestPermissions } from '../native/TapPayNative';
import { advertiseAndAwaitSession, connectAndEstablishSession, type BleSession } from '../payments/bleTransport';

/**
 * M3 Milestone 2, Phase B: isolates the real GATT transport +
 * authenticated-session handshake (bleTransport.ts, Milestone 2 Phase A)
 * from payment-flow complexity, the same precedent SessionDemoScreen.tsx set
 * for the ECDH layer itself -- prove the riskiest new layer alone first.
 *
 * Unlike SessionDemoScreen (which can run both sides in one process over
 * QR/paste), BLE needs two REAL radios: this screen only ever drives ONE
 * local identity, with a role toggle (advertise = peripheral/RECEIVE,
 * connect = central/SEND) exactly like the retired TapScreen.tsx's role
 * toggle. Two physical phones, each on this tab with opposite roles, is the
 * actual test.
 */

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

type Role = 'advertise' | 'connect';

export default function BleDemoScreen() {
  const [email, setEmail] = useState('ble-demo@tappay.local');
  const [identity, setIdentity] = useState<EnrolledIdentity | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  const [role, setRole] = useState<Role>('advertise');
  const [targetDeviceIdInput, setTargetDeviceIdInput] = useState('');

  const [rawConnectionState, setRawConnectionState] = useState('idle');
  const [establishing, setEstablishing] = useState(false);
  const [session, setSession] = useState<BleSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [messageInput, setMessageInput] = useState('hello over BLE');
  const [log, setLog] = useState<string[]>([]);

  const sessionRef = useRef<BleSession | null>(null);

  useEffect(() => {
    const subscription = onBleTransportConnectionState(({ state }) => setRawConnectionState(state));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!session) return;
    const unsubscribe = session.onMessage((plaintext) => {
      setLog((prev) => [...prev, `received: "${bytesToAscii(plaintext)}"`]);
    });
    return unsubscribe;
  }, [session]);

  const handleEnroll = useCallback(async () => {
    setEnrolling(true);
    setError(null);
    try {
      const enrolled = await enrollDevice(email);
      setIdentity(enrolled);
    } catch (err) {
      setError(String(err));
    } finally {
      setEnrolling(false);
    }
  }, [email]);

  const closeSession = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    setSession(null);
  }, []);

  const handleEstablish = useCallback(async () => {
    if (!identity) return;
    setError(null);
    setLog([]);
    closeSession();
    setEstablishing(true);
    try {
      const granted = await requestPermissions().catch((err) => {
        throw new Error(`permission request failed: ${String(err)}`);
      });
      if (!granted) throw new Error('BLE permissions were not granted');

      const established =
        role === 'advertise'
          ? await advertiseAndAwaitSession(identity)
          : await connectAndEstablishSession(identity, uuidToBytes(targetDeviceIdInput.trim()));
      sessionRef.current = established;
      setSession(established);
      setLog((prev) => [...prev, `session established with peer ${established.peerDeviceId.slice(0, 8)}…`]);
    } catch (err) {
      setError(String(err));
    } finally {
      setEstablishing(false);
    }
  }, [identity, role, targetDeviceIdInput, closeSession]);

  const handleSend = useCallback(async () => {
    if (!session) return;
    setError(null);
    try {
      await session.send(asciiToBytes(messageInput));
      setLog((prev) => [...prev, `sent: "${messageInput}"`]);
    } catch (err) {
      setError(String(err));
    }
  }, [session, messageInput]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>BLE GATT transport (M3 Milestone 2)</Text>
      <Text style={styles.subtitle}>
        Drives the real BleGattTransport.kt + the authenticated session handshake (bleTransport.ts) on THIS phone&apos;s
        radio only. Run this tab on two physical phones with opposite roles: one &quot;Advertise&quot;, one &quot;Connect&quot; pointed
        at the advertiser&apos;s device id below.
      </Text>

      <View style={styles.row}>
        <Text style={styles.rowLabel}>Email</Text>
        <TextInput accessibilityLabel="Text input field"
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          editable={!identity}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!identity && (
          <TouchableOpacity accessibilityRole="button" style={styles.smallButton} onPress={() => void handleEnroll()} disabled={enrolling}>
            <Text style={styles.smallButtonText}>{enrolling ? 'Enrolling…' : 'Enroll'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {identity && (
        <View style={styles.readout}>
          <Text style={styles.readoutText}>own device_id (give this to the &quot;Connect&quot; side): {identity.deviceId}</Text>
          <Text style={styles.readoutText}>StrongBox: {identity.strongBoxBacked ? 'yes' : 'no (TEE fallback)'}</Text>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {identity && !session && (
        <>
          <View style={styles.row}>
            <TouchableOpacity accessibilityRole="button"
              style={[styles.roleButton, role === 'advertise' && styles.roleButtonActive]}
              onPress={() => setRole('advertise')}
            >
              <Text style={styles.smallButtonText}>Advertise (RECEIVE)</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button"
              style={[styles.roleButton, role === 'connect' && styles.roleButtonActive]}
              onPress={() => setRole('connect')}
            >
              <Text style={styles.smallButtonText}>Connect (SEND)</Text>
            </TouchableOpacity>
          </View>

          {role === 'connect' && (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Target device_id</Text>
              <TextInput accessibilityLabel="Text input field"
                style={styles.input}
                value={targetDeviceIdInput}
                onChangeText={setTargetDeviceIdInput}
                placeholder="paste the advertiser's device_id"
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          )}

          <TouchableOpacity accessibilityRole="button"
            style={styles.button}
            onPress={() => void handleEstablish()}
            disabled={establishing || (role === 'connect' && targetDeviceIdInput.trim().length === 0)}
          >
            <Text style={styles.buttonText}>
              {establishing
                ? role === 'advertise'
                  ? 'Advertising, waiting for peer…'
                  : 'Connecting…'
                : role === 'advertise'
                  ? 'Start advertising & await session'
                  : 'Connect & establish session'}
            </Text>
          </TouchableOpacity>
        </>
      )}

      <View style={styles.readout}>
        <Text style={styles.readoutText}>raw connection state: {rawConnectionState}</Text>
      </View>

      {session && (
        <View style={styles.section}>
          <Text style={styles.settledText}>session established -- peer {session.peerDeviceId.slice(0, 8)}…</Text>
          <View style={styles.row}>
            <TextInput accessibilityLabel="Text input field" style={styles.input} value={messageInput} onChangeText={setMessageInput} />
            <TouchableOpacity accessibilityRole="button" style={styles.smallButton} onPress={() => void handleSend()}>
              <Text style={styles.smallButtonText}>Send</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity accessibilityRole="button" style={styles.smallButton} onPress={closeSession}>
            <Text style={styles.smallButtonText}>Close session</Text>
          </TouchableOpacity>
        </View>
      )}

      {log.length > 0 && (
        <View style={styles.readout}>
          {log.map((line, i) => (
            <Text key={i} style={styles.readoutText}>
              {line}
            </Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  content: { padding: 16, gap: 12 },
  title: { color: '#eee', fontSize: 18, fontWeight: '600' },
  subtitle: { color: '#888', fontSize: 12, marginBottom: 8 },
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
  roleButton: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: '#1b1b1b', borderRadius: 8 },
  roleButtonActive: { backgroundColor: '#2a4a6a' },
  error: { color: '#ff6b6b' },
  readout: { padding: 12, backgroundColor: '#1b1b1b', borderRadius: 8, gap: 4 },
  readoutText: { color: '#ccc', fontFamily: 'monospace', fontSize: 12 },
  button: { backgroundColor: '#4ea8ff', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#111', fontWeight: '700', fontSize: 15 },
  section: { gap: 8 },
  settledText: { color: '#4eff8a', fontWeight: '700', fontSize: 15 },
});
