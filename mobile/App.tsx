import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import OfflineScreen from './src/screens/OfflineScreen';
import TapScreen from './src/screens/TapScreen';
import TelemetryScreen from './src/screens/TelemetryScreen';

// Dev-tool UI only, switching between M0 (sensor/bump telemetry, still open --
// no validated bump detection yet), M1 (QR transport crypto/ledger flow, Mode
// A only), and M2 (Mode B bridge + Mode C offline IOU). None of these is the
// real polished TapScreen of later milestones.
type Screen = 'telemetry' | 'tap' | 'offline';

export default function App() {
  const [screen, setScreen] = useState<Screen>('tap');

  return (
    <>
      <View style={styles.switcher}>
        <TouchableOpacity style={[styles.tab, screen === 'tap' && styles.tabActive]} onPress={() => setScreen('tap')}>
          <Text style={[styles.tabText, screen === 'tap' && styles.tabTextActive]}>QR (M1)</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, screen === 'offline' && styles.tabActive]} onPress={() => setScreen('offline')}>
          <Text style={[styles.tabText, screen === 'offline' && styles.tabTextActive]}>Offline (M2)</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, screen === 'telemetry' && styles.tabActive]}
          onPress={() => setScreen('telemetry')}
        >
          <Text style={[styles.tabText, screen === 'telemetry' && styles.tabTextActive]}>Telemetry (M0)</Text>
        </TouchableOpacity>
      </View>
      {screen === 'tap' && <TapScreen />}
      {screen === 'offline' && <OfflineScreen />}
      {screen === 'telemetry' && <TelemetryScreen />}
      <StatusBar style="light" />
    </>
  );
}

const styles = StyleSheet.create({
  switcher: { flexDirection: 'row', backgroundColor: '#111', paddingTop: 48, paddingHorizontal: 16, gap: 8 },
  tab: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: '#1b1b1b' },
  tabActive: { backgroundColor: '#4ea8ff' },
  tabText: { color: '#aaa', fontSize: 13 },
  tabTextActive: { color: '#111', fontWeight: '700' },
});
