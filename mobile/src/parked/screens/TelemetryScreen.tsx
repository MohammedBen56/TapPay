import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { HIGH_PASS_ALPHA, getThresholdsForDevice } from '../config/sensorThresholds';
import { onRssiSample, onSensorBatch, requestPermissions, startStreaming, stopStreaming } from '../native/TapPayNative';
import type { SensorSample, Vec3 } from '../native/TapPayNative';
import { TelemetryClient, type BumpTag, type ConnectionStatus, type DeviceRole } from '../telemetry/TelemetryClient';
import { uuidv4 } from '../../util/uuid';

const GRAVITY = 9.80665;
const GRIPS = ['firm', 'loose'];
const ORIENTATIONS = ['face-up', 'face-down', 'edge-on'];
const CONTACT_POINTS = ['top-edge', 'back-center', 'corner'];
// How long the "BUMP DETECTED" indicator stays lit, and how long detection is
// suppressed afterward -- a real bump is a single sharp transient that stays above
// threshold across several consecutive 100Hz samples, so without this the single
// physical event would otherwise fire many times in a row.
const BUMP_COOLDOWN_MS = 1200;

/** Same recursive filter as compute_correlation.py's highpass_accel, run sample-by-
 * sample on-device instead of over a whole recorded array -- lets the live detector
 * use the exact math the peakAccelMinG thresholds were calibrated against, not an
 * approximation of it. `prevRaw`/`prevFiltered` are the filter's carried state;
 * pass null prevRaw for the very first sample (filtered defined as 0 there, matching
 * the offline implementation's filtered[0] = 0). */
function highpassStep(raw: Vec3, prevRaw: Vec3 | null, prevFiltered: Vec3): Vec3 {
  if (!prevRaw) return [0, 0, 0];
  return [
    HIGH_PASS_ALPHA * (prevFiltered[0] + raw[0] - prevRaw[0]),
    HIGH_PASS_ALPHA * (prevFiltered[1] + raw[1] - prevRaw[1]),
    HIGH_PASS_ALPHA * (prevFiltered[2] + raw[2] - prevRaw[2]),
  ];
}

function magnitude([x, y, z]: Vec3): number {
  return Math.sqrt(x * x + y * y + z * z);
}

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
  // Editable in the UI -- this WILL go stale whenever the dev machine's LAN IP
  // changes (DHCP lease renewal, different network), and a stale/wrong host here
  // fails *silently* from the phone's point of view (see the "harness" status
  // readout below, which exists specifically to make that failure visible
  // instead of "armed" quietly meaning nothing is actually being recorded). Use
  // "localhost:8080" instead if you're on USB with `adb reverse tcp:8080 tcp:8080`.
  const [harnessHost, setHarnessHost] = useState('192.168.1.23:8080');
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
  const [harnessStatus, setHarnessStatus] = useState<ConnectionStatus | null>(null);
  const [bumpDetected, setBumpDetected] = useState(false);
  const [detectedBumpCount, setDetectedBumpCount] = useState(0);

  // Platform.constants.Model is Build.MODEL on Android (e.g. "SM-S928B") -- the app
  // is Android-only (CLAUDE.md S2), so no OS branch is needed beyond this guard.
  const deviceModel = Platform.OS === 'android' ? (Platform.constants as { Model?: string }).Model ?? null : null;
  const thresholds = useMemo(() => getThresholdsForDevice(deviceModel), [deviceModel]);

  const clientRef = useRef<TelemetryClient | null>(null);
  const tag = useMemo<BumpTag>(() => ({ grip, orientation, contactPoint }), [grip, orientation, contactPoint]);
  const tagRef = useRef(tag);
  tagRef.current = tag;

  // Live bump-detector filter state, carried across sensor batches (see
  // highpassStep) -- reset each time capture is (re-)armed, in the effect below.
  const prevRawAccelRef = useRef<Vec3 | null>(null);
  const prevFilteredAccelRef = useRef<Vec3>([0, 0, 0]);
  const bumpCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const processSampleForBumpDetection = useCallback(
    (sample: SensorSample) => {
      const filtered = highpassStep(sample.accel, prevRawAccelRef.current, prevFilteredAccelRef.current);
      prevRawAccelRef.current = sample.accel;
      prevFilteredAccelRef.current = filtered;

      const peakG = magnitude(filtered) / GRAVITY;
      if (peakG >= thresholds.peakAccelMinG && !bumpCooldownRef.current) {
        setBumpDetected(true);
        setDetectedBumpCount((n) => n + 1);
        clientRef.current?.sendBumpDetected(peakG, thresholds.peakAccelMinG);
        bumpCooldownRef.current = setTimeout(() => {
          setBumpDetected(false);
          bumpCooldownRef.current = null;
        }, BUMP_COOLDOWN_MS);
      }
    },
    [thresholds],
  );

  useEffect(() => {
    if (!armed) return;

    // Fresh filter/detector state each arm -- highpassStep's prevRaw=null case
    // matches the offline pipeline's filtered[0]=0 starting condition, which
    // assumes starting from rest at the beginning of a capture.
    prevRawAccelRef.current = null;
    prevFilteredAccelRef.current = [0, 0, 0];
    setBumpDetected(false);
    setDetectedBumpCount(0);

    const client = new TelemetryClient(
      {
        url: `ws://${harnessHost}/ws/ingest`,
        sessionId,
        deviceRole,
        deviceId,
      },
      setHarnessStatus,
    );
    clientRef.current = client;

    const sensorSub = onSensorBatch((event) => {
      client.sendSensorBatch(event.samples, tagRef.current);
      for (const sample of event.samples) {
        processSampleForBumpDetection(sample);
      }
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
      setHarnessStatus(null);
      if (bumpCooldownRef.current) {
        clearTimeout(bumpCooldownRef.current);
        bumpCooldownRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, harnessHost, sessionId, deviceRole, deviceId, processSampleForBumpDetection]);

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
        <TextInput
          style={[styles.input, styles.sessionText]}
          value={sessionId}
          onChangeText={setSessionId}
          editable={!armed}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.smallButton} onPress={handleNewSession} disabled={armed}>
          <Text style={styles.smallButtonText}>New</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.hint}>
        Both phones must use the identical session id to land in the same file for analysis -- generate it on one
        phone, then copy/type it into the other before arming.
      </Text>

      <SegmentedRow label="Grip" options={GRIPS} value={grip} onChange={setGrip} />
      <SegmentedRow label="Orientation" options={ORIENTATIONS} value={orientation} onChange={setOrientation} />
      <SegmentedRow label="Contact point" options={CONTACT_POINTS} value={contactPoint} onChange={setContactPoint} />

      <View style={styles.row}>
        <Text style={styles.rowLabel}>Arm capture</Text>
        <Switch value={armed} onValueChange={handleArmToggle} />
      </View>

      {permissionError && <Text style={styles.error}>{permissionError}</Text>}
      {armed && harnessStatus !== 'open' && (
        <Text style={styles.error}>
          harness: {harnessStatus === 'connecting' ? 'connecting…' : 'disconnected, retrying…'} (nothing is reaching{' '}
          {harnessHost} -- check the host/network)
        </Text>
      )}

      {armed && (
        <View style={[styles.bumpIndicator, bumpDetected && styles.bumpIndicatorActive]}>
          <Text style={[styles.bumpIndicatorText, bumpDetected && styles.bumpIndicatorTextActive]}>
            {bumpDetected ? 'BUMP DETECTED' : 'listening for bump…'}
          </Text>
        </View>
      )}

      <View style={styles.readout}>
        <Text style={styles.readoutText}>
          harness: {armed ? (harnessStatus === 'open' ? 'connected' : (harnessStatus ?? 'connecting')) : '--'}
        </Text>
        <Text style={styles.readoutText}>accel: {lastAccelG !== null ? `${lastAccelG.toFixed(2)} g` : '--'}</Text>
        <Text style={styles.readoutText}>rssi: {lastRssiDbm !== null ? `${lastRssiDbm} dBm` : '--'}</Text>
        <Text style={styles.readoutText}>markers this session: {markerCount}</Text>
        <Text style={styles.readoutText}>bumps detected this session: {detectedBumpCount}</Text>
        <Text style={styles.readoutText}>
          device: {deviceModel ?? 'unknown'} (threshold {thresholds.peakAccelMinG.toFixed(2)}g
          {deviceModel && !['SM-S928B', 'SM-A515F'].includes(deviceModel) ? ', uncalibrated fallback' : ''})
        </Text>
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
  hint: { color: '#777', fontSize: 12, marginTop: -6 },
  bumpIndicator: { marginTop: 8, paddingVertical: 20, borderRadius: 10, alignItems: 'center', backgroundColor: '#1b1b1b', borderWidth: 2, borderColor: '#333' },
  bumpIndicatorActive: { backgroundColor: '#1e4620', borderColor: '#3ddc55' },
  bumpIndicatorText: { color: '#666', fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  bumpIndicatorTextActive: { color: '#3ddc55', fontSize: 20 },
  readout: { marginTop: 8, padding: 12, backgroundColor: '#1b1b1b', borderRadius: 8, gap: 4 },
  readoutText: { color: '#ccc', fontFamily: 'monospace' },
  markButton: { marginTop: 8, backgroundColor: '#ff8a4e', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  markButtonDisabled: { backgroundColor: '#4a3a2e' },
  markButtonText: { color: '#111', fontWeight: '700', fontSize: 16 },
});
