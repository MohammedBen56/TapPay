import { decodeTxReceipt, encodeTxProposal, signCoseSign1, uuidToBytes, verifyCoseSign1, type TxProposal } from '@tappay/shared';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { getServerPublicKeyBytes } from '../config/serverPublicKey';
import { SERVER_BASE_URL } from '../config/serverUrl';
import { createIdentitySigner, enrollDevice, type EnrolledIdentity } from '../crypto/identity';
import { bytesToQrString, decodeTxRequest, encodeTxRequest, qrStringToBytes, type TxRequest } from '../transport/qr';
import { uuidv4 } from '../util/uuid';

/**
 * Dev-flow screen driving the M1 QR round trip -- not the polished TapScreen
 * of later milestones, just enough UI to prove the crypto/ledger pipeline
 * works end to end. A 3-QR round trip mirroring Mode A's shape without BLE
 * (spec calls QR "the zero-radio path for end-to-end validation" but doesn't
 * choreograph it -- this is the concrete design from M1 planning):
 *
 *   1. Payee shows a "Request" QR: {recipient_device_id, receiver_nonce, ts}.
 *      Unsigned by design -- the payer's proposal is what's cryptographically
 *      bound to a transaction; this is just an invitation carrying the nonce
 *      that proposal must embed.
 *   2. Payer scans it, enters an amount, signs a TxProposal embedding that
 *      nonce (biometric prompt happens here), shows the result as a
 *      "Proposal" QR (raw COSE_Sign1 bytes, base64).
 *   3. Payee scans the Proposal QR, POSTs it straight to /tx/submit (payee is
 *      online -- Mode A), gets back a signed receipt, shows SETTLED, and
 *      displays the receipt as a "Receipt" QR.
 *   4. Payer scans the Receipt QR, verifies it against the pinned server
 *      public key locally (no network round trip needed), shows SETTLED.
 *
 * Every "scanning" step also has a manual paste fallback: two roles usually
 * means two phones, but phone B isn't reachable in this dev environment yet
 * (a separate, unrelated usbipd issue), so the whole round trip needs to be
 * exercisable on ONE phone first. A single camera can't scan its own screen,
 * so each QR's raw string is shown as selectable text beneath it -- copy it
 * out of one role's step and paste it into the other role's input after
 * switching roles.
 */

type Role = 'payee' | 'payer';
type PayeeStep = 'idle' | 'request' | 'scan-proposal' | 'settled';
type PayerStep = 'idle' | 'scan-request' | 'amount' | 'proposal' | 'scan-receipt' | 'settled';

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

function ScanStep({ label, onManualSubmit }: { label: string; onManualSubmit: (data: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manualInput, setManualInput] = useState('');
  const [locked, setLocked] = useState(false);

  const handleScanned = useCallback(
    ({ data }: { data: string }) => {
      if (locked) return;
      setLocked(true);
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

function QrWithCopyableText({ value }: { value: string }) {
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

export default function TapScreen() {
  const [email, setEmail] = useState('alice@tappay.local');
  const [identity, setIdentity] = useState<EnrolledIdentity | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [role, setRole] = useState<Role>('payee');
  const [payeeStep, setPayeeStep] = useState<PayeeStep>('idle');
  const [payerStep, setPayerStep] = useState<PayerStep>('idle');

  const [receiverNonce, setReceiverNonce] = useState<Uint8Array | null>(null);
  const [settledReceiptQr, setSettledReceiptQr] = useState<string | null>(null);

  const [scannedRequest, setScannedRequest] = useState<TxRequest | null>(null);
  const [amountInput, setAmountInput] = useState('100');
  const [proposalQr, setProposalQr] = useState<string | null>(null);
  const [settledAmount, setSettledAmount] = useState<{ amount: bigint; currency: string } | null>(null);

  const handleEnroll = useCallback(async () => {
    setEnrolling(true);
    setError(null);
    try {
      setIdentity(await enrollDevice(email));
    } catch (err) {
      setError(String(err));
    } finally {
      setEnrolling(false);
    }
  }, [email]);

  const resetFlow = useCallback(() => {
    setPayeeStep('idle');
    setPayerStep('idle');
    setReceiverNonce(null);
    setSettledReceiptQr(null);
    setScannedRequest(null);
    setProposalQr(null);
    setSettledAmount(null);
    setError(null);
  }, []);

  // --- Payee ---

  const requestQr = useMemo(() => {
    if (!identity || !receiverNonce) return null;
    const bytes = encodeTxRequest({ recipientDeviceId: identity.deviceId, receiverNonce, ts: Date.now() });
    return bytesToQrString(bytes);
  }, [identity, receiverNonce]);

  const handleStartRequest = useCallback(() => {
    setReceiverNonce(Crypto.getRandomBytes(16));
    setPayeeStep('request');
  }, []);

  const handleProposalReceived = useCallback(async (qrData: string) => {
    setError(null);
    try {
      const res = await fetch(`${SERVER_BASE_URL}/tx/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cose_sign1: qrData }),
      });
      const body = (await res.json()) as { receipt?: string; message?: string; error?: string };
      if (!res.ok || !body.receipt) {
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      setSettledReceiptQr(bytesToQrString(qrStringToBytes(body.receipt)));
      setPayeeStep('settled');
    } catch (err) {
      setError(String(err));
      setPayeeStep('request');
    }
  }, []);

  // --- Payer ---

  const handleRequestReceived = useCallback((qrData: string) => {
    setError(null);
    try {
      setScannedRequest(decodeTxRequest(qrStringToBytes(qrData)));
      setPayerStep('amount');
    } catch (err) {
      setError(String(err));
      setPayerStep('scan-request');
    }
  }, []);

  const handleBuildProposal = useCallback(async () => {
    if (!identity || !scannedRequest) return;
    setError(null);
    try {
      const amount = BigInt(amountInput);
      const proposal: TxProposal = {
        tx_uuid: uuidToBytes(uuidv4()),
        sender_device_id: uuidToBytes(identity.deviceId),
        recipient_device_id: uuidToBytes(scannedRequest.recipientDeviceId),
        amount,
        currency: 'MAD',
        receiver_nonce: scannedRequest.receiverNonce,
        ts: Date.now(),
      };
      const payload = encodeTxProposal(proposal);
      // Shows the system biometric prompt (KeyStoreManager.sign, M1 Step 6).
      const coseBytes = await signCoseSign1(payload, createIdentitySigner(identity.deviceId));
      setProposalQr(bytesToQrString(coseBytes));
      setPayerStep('proposal');
    } catch (err) {
      setError(String(err));
    }
  }, [identity, scannedRequest, amountInput]);

  const handleReceiptReceived = useCallback((qrData: string) => {
    setError(null);
    try {
      const receiptBytes = qrStringToBytes(qrData);
      const verified = verifyCoseSign1(receiptBytes, getServerPublicKeyBytes());
      if (!verified) throw new Error('receipt signature does not verify against the pinned server key');
      const receipt = decodeTxReceipt(verified.payload);
      setSettledAmount({ amount: receipt.amount, currency: receipt.currency });
      setPayerStep('settled');
    } catch (err) {
      setError(String(err));
      setPayerStep('scan-receipt');
    }
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>TapPay QR Transport (M1)</Text>

      <View style={styles.row}>
        <Text style={styles.rowLabel}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          editable={!identity}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!identity && (
          <TouchableOpacity style={styles.smallButton} onPress={() => void handleEnroll()} disabled={enrolling}>
            <Text style={styles.smallButtonText}>{enrolling ? 'Enrolling…' : 'Enroll'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {identity && (
        <View style={styles.readout}>
          <Text style={styles.readoutText}>device: {identity.deviceId.slice(0, 8)}</Text>
          <Text style={styles.readoutText}>account: {identity.accountId.slice(0, 8)}</Text>
          <Text style={styles.readoutText}>StrongBox: {identity.strongBoxBacked ? 'yes' : 'no (TEE fallback)'}</Text>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {identity && (
        <>
          <SegmentedRow
            label="Role"
            options={['payee', 'payer'] as const}
            value={role}
            onChange={(next) => {
              setRole(next);
              resetFlow();
            }}
          />

          {role === 'payee' && (
            <>
              {payeeStep === 'idle' && (
                <TouchableOpacity style={styles.button} onPress={handleStartRequest}>
                  <Text style={styles.buttonText}>Request payment</Text>
                </TouchableOpacity>
              )}
              {payeeStep === 'request' && requestQr && (
                <>
                  <QrWithCopyableText value={requestQr} />
                  <TouchableOpacity style={styles.button} onPress={() => setPayeeStep('scan-proposal')}>
                    <Text style={styles.buttonText}>Payer signed it -- scan their proposal</Text>
                  </TouchableOpacity>
                </>
              )}
              {payeeStep === 'scan-proposal' && (
                <ScanStep label="Scan the payer's Proposal QR" onManualSubmit={(data) => void handleProposalReceived(data)} />
              )}
              {payeeStep === 'settled' && settledReceiptQr && (
                <>
                  <Text style={styles.settledText}>SETTLED</Text>
                  <Text style={styles.rowLabel}>Show this receipt to the payer:</Text>
                  <QrWithCopyableText value={settledReceiptQr} />
                  <TouchableOpacity style={styles.button} onPress={resetFlow}>
                    <Text style={styles.buttonText}>Start over</Text>
                  </TouchableOpacity>
                </>
              )}
            </>
          )}

          {role === 'payer' && (
            <>
              {payerStep === 'idle' && (
                <TouchableOpacity style={styles.button} onPress={() => setPayerStep('scan-request')}>
                  <Text style={styles.buttonText}>Scan a payment request</Text>
                </TouchableOpacity>
              )}
              {payerStep === 'scan-request' && (
                <ScanStep label="Scan the payee's Request QR" onManualSubmit={handleRequestReceived} />
              )}
              {payerStep === 'amount' && scannedRequest && (
                <View style={styles.section}>
                  <Text style={styles.stepLabel}>Recipient: {scannedRequest.recipientDeviceId.slice(0, 8)}</Text>
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Amount (centimes)</Text>
                    <TextInput
                      style={styles.input}
                      value={amountInput}
                      onChangeText={setAmountInput}
                      keyboardType="number-pad"
                    />
                  </View>
                  <TouchableOpacity style={styles.button} onPress={() => void handleBuildProposal()}>
                    <Text style={styles.buttonText}>Sign proposal (biometric prompt)</Text>
                  </TouchableOpacity>
                </View>
              )}
              {payerStep === 'proposal' && proposalQr && (
                <>
                  <QrWithCopyableText value={proposalQr} />
                  <TouchableOpacity style={styles.button} onPress={() => setPayerStep('scan-receipt')}>
                    <Text style={styles.buttonText}>Payee submitted it -- scan their receipt</Text>
                  </TouchableOpacity>
                </>
              )}
              {payerStep === 'scan-receipt' && (
                <ScanStep label="Scan the payee's Receipt QR" onManualSubmit={handleReceiptReceived} />
              )}
              {payerStep === 'settled' && settledAmount && (
                <>
                  <Text style={styles.settledText}>
                    SETTLED -- {settledAmount.amount.toString()} {settledAmount.currency}
                  </Text>
                  <TouchableOpacity style={styles.button} onPress={resetFlow}>
                    <Text style={styles.buttonText}>Start over</Text>
                  </TouchableOpacity>
                </>
              )}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  content: { padding: 16, gap: 12 },
  title: { color: '#eee', fontSize: 18, fontWeight: '600', marginBottom: 8 },
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
  error: { color: '#ff6b6b' },
  readout: { padding: 12, backgroundColor: '#1b1b1b', borderRadius: 8, gap: 4 },
  readoutText: { color: '#ccc', fontFamily: 'monospace' },
  button: { backgroundColor: '#4ea8ff', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#111', fontWeight: '700', fontSize: 15 },
  section: { gap: 8 },
  stepLabel: { color: '#eee', fontWeight: '600' },
  camera: { width: '100%', height: 260, borderRadius: 8, overflow: 'hidden' },
  orDivider: { color: '#666', textAlign: 'center', fontSize: 12 },
  qrWrap: { alignItems: 'center', padding: 16, backgroundColor: '#1b1b1b', borderRadius: 8 },
  copyableText: { color: '#666', fontFamily: 'monospace', fontSize: 10 },
  settledText: { color: '#4eff8a', fontWeight: '700', fontSize: 18, textAlign: 'center' },
});
