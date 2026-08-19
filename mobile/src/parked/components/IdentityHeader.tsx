import { formatMinorUnits } from '@tappay/shared';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { EnrolledIdentity } from '../crypto/identity';

/**
 * The unified Pay screen's header (Phase 5): enroll, device/account readout,
 * a connectivity indicator (probeServerReachable's result), and the balance
 * readout -- the first caller of GET /accounts/:accountId/balance anywhere
 * in the mobile app. Presentational only; PayScreen.tsx owns all the state
 * this displays and re-probes/re-fetches on its own schedule.
 */
export function IdentityHeader({
  email,
  onEmailChange,
  identity,
  enrolling,
  onEnroll,
  online,
  balance,
  onRefreshBalance,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  identity: EnrolledIdentity | null;
  enrolling: boolean;
  onEnroll: () => void;
  online: boolean | null; // null = still probing
  balance: bigint | null; // null = not yet fetched
  onRefreshBalance: () => void;
}) {
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Email</Text>
        <TextInput accessibilityLabel="Text input field"
          style={styles.input}
          value={email}
          onChangeText={onEmailChange}
          editable={!identity}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!identity && (
          <TouchableOpacity accessibilityRole="button" style={styles.smallButton} onPress={onEnroll} disabled={enrolling}>
            <Text style={styles.smallButtonText}>{enrolling ? 'Enrolling…' : 'Enroll'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {identity && (
        <View style={styles.readout}>
          <View style={styles.row}>
            <Text style={styles.readoutText}>device: {identity.deviceId.slice(0, 8)}</Text>
            <View style={[styles.dot, { backgroundColor: online === null ? '#666' : online ? '#4eff8a' : '#ff6b6b' }]} />
            <Text style={styles.readoutText}>{online === null ? 'checking…' : online ? 'online' : 'offline'}</Text>
          </View>
          <Text style={styles.readoutText}>account: {identity.accountId.slice(0, 8)}</Text>
          <Text style={styles.readoutText}>StrongBox: {identity.strongBoxBacked ? 'yes' : 'no (TEE fallback)'}</Text>
          <View style={styles.row}>
            <Text style={styles.balanceText}>{balance === null ? '—' : `${formatMinorUnits(balance)} MAD`}</Text>
            <TouchableOpacity accessibilityRole="button" style={styles.smallButton} onPress={onRefreshBalance}>
              <Text style={styles.smallButtonText}>Refresh</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
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
  readout: { padding: 12, backgroundColor: '#1b1b1b', borderRadius: 8, gap: 6 },
  readoutText: { color: '#ccc', fontFamily: 'monospace' },
  balanceText: { color: '#4ea8ff', fontFamily: 'monospace', fontSize: 16, fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
