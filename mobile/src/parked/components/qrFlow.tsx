import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

/** How long the camera ignores new scans after one fires, so a misaimed scan
 * (wrong QR, decode error) doesn't permanently kill the camera for callers
 * that handle the error by staying on the same step -- see ScanStep below. */
const SCAN_DEBOUNCE_MS = 1500;

/**
 * Extracted from TapScreen.tsx (M1) so OfflineScreen.tsx (M2, Mode B/C) doesn't
 * duplicate the same ~90 lines of QR-display/scan-with-paste-fallback UI --
 * pure extraction, no behavior change. See the M2 plan's gap #7 for why Mode
 * B/C got their own screen instead of extending TapScreen directly.
 */

export function SegmentedRow<T extends string>({
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

export function ScanStep({ label, onManualSubmit }: { label: string; onManualSubmit: (data: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manualInput, setManualInput] = useState('');
  const [locked, setLocked] = useState(false);
  const unlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (unlockTimer.current) clearTimeout(unlockTimer.current);
    };
  }, []);

  const handleScanned = useCallback(
    ({ data }: { data: string }) => {
      if (locked) return;
      setLocked(true);
      unlockTimer.current = setTimeout(() => setLocked(false), SCAN_DEBOUNCE_MS);
      onManualSubmit(data);
    },
    [locked, onManualSubmit],
  );

  return (
    <View style={styles.section}>
      <Text style={styles.stepLabel}>{label}</Text>
      {permission?.granted ? (
        <CameraView style={styles.camera} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={handleScanned} />
      ) : (
        <TouchableOpacity style={styles.button} onPress={() => void requestPermission()}>
          <Text style={styles.buttonText}>Grant camera permission</Text>
        </TouchableOpacity>
      )}
      <Text style={styles.orDivider}>-- or paste (one-phone testing) --</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={manualInput}
          onChangeText={setManualInput}
          placeholder="paste QR string here"
          placeholderTextColor="#666"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.smallButton} onPress={() => onManualSubmit(manualInput.trim())}>
          <Text style={styles.smallButtonText}>Submit</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function QrWithCopyableText({ value }: { value: string }) {
  return (
    <View style={styles.section}>
      <View style={styles.qrWrap}>
        <QRCode value={value} size={220} backgroundColor="#1b1b1b" color="#eee" />
      </View>
      <Text selectable style={styles.copyableText}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
  segmentGroup: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', flex: 1 },
  segment: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#1b1b1b', borderRadius: 6, borderWidth: 1, borderColor: '#333' },
  segmentActive: { backgroundColor: '#4ea8ff', borderColor: '#4ea8ff' },
  segmentText: { color: '#aaa', fontSize: 12 },
  segmentTextActive: { color: '#111', fontWeight: '600' },
  button: { backgroundColor: '#4ea8ff', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#111', fontWeight: '700', fontSize: 15 },
  section: { gap: 8 },
  stepLabel: { color: '#eee', fontWeight: '600' },
  camera: { width: '100%', height: 260, borderRadius: 8, overflow: 'hidden' },
  orDivider: { color: '#666', textAlign: 'center', fontSize: 12 },
  qrWrap: { alignItems: 'center', padding: 16, backgroundColor: '#1b1b1b', borderRadius: 8 },
  copyableText: { color: '#666', fontFamily: 'monospace', fontSize: 10 },
});
