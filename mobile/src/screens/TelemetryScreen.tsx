import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { onRssiSample, onSensorBatch, requestPermissions, startStreaming, stopStreaming } from '../native/TapPayNative';
import { TelemetryClient, type BumpTag, type DeviceRole } from '../telemetry/TelemetryClient';
import { uuidv4 } from '../util/uuid';

const GRAVITY = 9.80665;
const GRIPS = ['firm', 'loose'];
const ORIENTATIONS = ['face-up', 'face-down', 'edge-on'];
const CONTACT_POINTS = ['top-edge', 'back-center', 'corner'];

function SegmentedRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.segmentGroup}>
        {options.map((option) => (
          <TouchableOpacity
            key={option}
            style={[styles.segment, option === value && styles.segmentActive]}
            onPress={() => onChange(option)}
          >
            <Text style={[styles.segmentText, option === value && styles.segmentTextActive]}>{option}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function TelemetryScreen() {
  // Default targets the dev machine's LAN IP (mirrored WSL2 networking makes the
  // Docker-hosted harness reachable there directly) so the phone can stream over
  // WiFi without a USB tether during actual bump testing. Still editable in the UI
  // if the machine's IP changes or you're back on adb reverse to localhost.
  const [harnessHost, setHarnessHost] = useState('192.168.1.17:8080');
  const [deviceRole, setDeviceRole] = useState<DeviceRole>('A');
  const [deviceId, setDeviceId] = useState(() => `phone-${uuidv4().slice(0, 8)}`);
  const [sessionId, setSessionId] = useState(() => uuidv4());
  const [grip, setGrip] = useState(GRIPS[0]);
  const [orientation, setOrientation] = useState(ORIENTATIONS[0]);
  const [contactPoint, setContactPoint] = useState(CONTACT_POINTS[0]);
  const [armed, setArmed] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [lastAccelG, setLastAccelG] = useState<number | null>(null);
  const [lastRssiDbm, setLastRssiDbm] = useState<number | null>(null);
  const [markerCount, setMarkerCount] = useState(0);

  const clientRef = useRef<TelemetryClient | null>(null);
  const tag = useMemo<BumpTag>(() => ({ grip, orientation, contactPoint }), [grip, orientation, contactPoint]);
  const tagRef = useRef(tag);
  tagRef.current = tag;

  useEffect(() => {
    if (!armed) return;

    const client = new TelemetryClient({
      url: `ws://${harnessHost}/ws/ingest`,
      sessionId,
      deviceRole,
      deviceId,
    });
    clientRef.current = client;

    const sensorSub = onSensorBatch((event) => {
      client.sendSensorBatch(event.samples, tagRef.current);
      const last = event.samples[event.samples.length - 1];
      if (last) {
        const [x, y, z] = last.accel;
        setLastAccelG(Math.sqrt(x * x + y * y + z * z) / GRAVITY);
      }
    });

    const rssiSub = onRssiSample((event) => {
      client.sendRssiSample({ t_device_ns: event.t_device_ns, dbm: event.dbm, peerAddr: event.peerAddr });
      setLastRssiDbm(event.dbm);
    });

    startStreaming().catch((err) => setPermissionError(String(err)));

    return () => {
      sensorSub.remove();
      rssiSub.remove();
      stopStreaming().catch(() => {});
      client.close();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, harnessHost, sessionId, deviceRole, deviceId]);

  const handleArmToggle = useCallback(async (next: boolean) => {
    if (next) {
      const granted = await requestPermissions().catch((err) => {
        setPermissionError(String(err));
        return false;
      });
      if (!granted) {
        setPermissionError('BLE/sensor permissions were not granted.');
        return;
      }
      setPermissionError(null);
    }
    setArmed(next);
  }, []);

  const handleNewSession = useCallback(() => {
    setSessionId(uuidv4());
    setMarkerCount(0);
  }, []);

  const handleMarkBump = useCallback(() => {
    clientRef.current?.sendBumpMarker(tagRef.current);
    setMarkerCount((n) => n + 1);
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>TapPay Telemetry (M0)</Text>

      <View style={styles.row}>
        <Text style={styles.rowLabel}>Harness host</Text>
        <TextInput
          style={styles.input}
          value={harnessHost}
          onChangeText={setHarnessHost}
          editable={!armed}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <SegmentedRow label="Role" options={['A', 'B'] as const} value={deviceRole} onChange={setDeviceRole} />

      <View style={styles.row}>
        <Text style={styles.rowLabel}>Device id</Text>
        <TextInput style={styles.input} value={deviceId} onChangeText={setDeviceId} editable={!armed} autoCapitalize="none" />
      </View>

      <View style={styles.row}>
        <Text style={styles.rowLabel}>Session</Text>
        <Text style={styles.sessionText}>{sessionId.slice(0, 8)}</Text>
        <TouchableOpacity style={styles.smallButton} onPress={handleNewSession} disabled={armed}>
          <Text style={styles.smallButtonText}>New</Text>
        </TouchableOpacity>
      </View>

      <SegmentedRow label="Grip" options={GRIPS} value={grip} onChange={setGrip} />
      <SegmentedRow label="Orientation" options={ORIENTATIONS} value={orientation} onChange={setOrientation} />
      <SegmentedRow label="Contact point" options={CONTACT_POINTS} value={contactPoint} onChange={setContactPoint} />

      <View style={styles.row}>
        <Text style={styles.rowLabel}>Arm capture</Text>
        <Switch value={armed} onValueChange={handleArmToggle} />
      </View>

      {permissionError && <Text style={styles.error}>{permissionError}</Text>}

      <View style={styles.readout}>
        <Text style={styles.readoutText}>accel: {lastAccelG !== null ? `${lastAccelG.toFixed(2)} g` : '--'}</Text>
        <Text style={styles.readoutText}>rssi: {lastRssiDbm !== null ? `${lastRssiDbm} dBm` : '--'}</Text>
        <Text style={styles.readoutText}>markers this session: {markerCount}</Text>
      </View>

      <TouchableOpacity style={[styles.markButton, !armed && styles.markButtonDisabled]} onPress={handleMarkBump} disabled={!armed}>
        <Text style={styles.markButtonText}>Mark Bump</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  content: { padding: 16, gap: 12 },
  title: { color: '#eee', fontSize: 18, fontWeight: '600', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowLabel: { color: '#aaa', width: 100 },
  input: { flex: 1, minWidth: 120, backgroundColor: '#1b1b1b', color: '#eee', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, borderWidth: 1, borderColor: '#333' },
  sessionText: { color: '#9ac', fontFamily: 'monospace' },
  smallButton: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#2a2a2a', borderRadius: 6 },
  smallButtonText: { color: '#eee' },
  segmentGroup: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', flex: 1 },
  segment: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#1b1b1b', borderRadius: 6, borderWidth: 1, borderColor: '#333' },
  segmentActive: { backgroundColor: '#4ea8ff', borderColor: '#4ea8ff' },
  segmentText: { color: '#aaa', fontSize: 12 },
  segmentTextActive: { color: '#111', fontWeight: '600' },
  error: { color: '#ff6b6b' },
  readout: { marginTop: 8, padding: 12, backgroundColor: '#1b1b1b', borderRadius: 8, gap: 4 },
  readoutText: { color: '#ccc', fontFamily: 'monospace' },
  markButton: { marginTop: 8, backgroundColor: '#ff8a4e', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  markButtonDisabled: { backgroundColor: '#4a3a2e' },
  markButtonText: { color: '#111', fontWeight: '700', fontSize: 16 },
});
