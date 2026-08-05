import {
  bytesToUuid,
  decodeCoseSign1Unverified,
  decodeFreshnessToken,
  decodeIncomingIouInfo,
  decodeTxReceipt,
  encodeIncomingIouInfo,
  encodeOfflineIou,
  encodeTxProposal,
  signCoseSign1,
  uuidToBytes,
  verifyCoseSign1,
  type OfflineIou,
  type TxProposal,
} from '@tappay/shared';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { QrWithCopyableText, ScanStep, SegmentedRow } from '../components/qrFlow';
import { getServerPublicKeyBytes } from '../config/serverPublicKey';
import { SERVER_BASE_URL } from '../config/serverUrl';
import { createIdentitySigner, enrollDevice, fetchFreshnessToken, type EnrolledIdentity } from '../crypto/identity';
import {
  cacheFreshnessToken,
  getCachedFreshnessToken,
  getNextSeq,
  insertIncomingIntent,
  insertPendingIntent,
  listIncomingIntents,
  listPendingIntents,
  listRecentIntents,
  markIncomingSettled,
  markSyncResult,
  type IncomingIntent,
  type IncomingStatus,
  type PendingIntent,
} from '../db/offlineIntents';
import { bytesToQrString, decodeTxRequest, encodeTxRequest, qrStringToBytes, type TxRequest } from '../transport/qr';
import { base64ToBytes, bytesToBase64 } from '../util/base64';
import { uuidv4 } from '../util/uuid';

/**
 * Dev-flow screen for Mode B (sender-online bridge) and Mode C (both-offline
 * signed IOU) -- the two connectivity modes M1's TapScreen.tsx doesn't cover
 * (that screen is Mode A only, deliberately left untouched by M2: see the M2
 * plan's gap #7). Same posture as TapScreen: this is a proof-of-pipeline dev
 * tool, not the polished production UI, and every "scan" step has a manual
 * paste fallback for one-phone testing.
 *
 * No real BLE/GATT exists yet (M3), so "offline" here just means "this screen
 * doesn't call fetch() for that step" -- Mode C's Sign & Send never touches the
 * network (that's the whole point); only Reconnect & Sync does.
 */

const FRESHNESS_TOKEN_TTL_MS = 24 * 60 * 60_000; // must match server config.offlineFreshnessTokenTtlMs

type Mode = 'B' | 'C';
type Role = 'payee' | 'payer';

type BPayeeStep = 'idle' | 'request' | 'scan-receipt' | 'settled';
type BPayerStep = 'idle' | 'scan-request' | 'amount' | 'done';
type CPayerStep = 'idle' | 'scan-recipient' | 'amount' | 'confirm';

function statusColor(status: PendingIntent['syncStatus']): string {
  if (status === 'SETTLED') return '#4eff8a';
  if (status === 'PENDING') return '#e0b03d';
  return '#ff6b6b'; // every FAILED_* status
}

function incomingStatusColor(status: IncomingStatus): string {
  // SETTLED here is set ONLY after independently verifying a real server
  // receipt (see markIncomingSettled's doc comment) -- INCOMING is amber,
  // full stop, same amber-until-proven-green discipline as the payer's own
  // PENDING_INTENT list.
  return status === 'SETTLED' ? '#4eff8a' : '#e0b03d';
}

export default function OfflineScreen() {
  const [email, setEmail] = useState('bob@tappay.local');
  const [identity, setIdentity] = useState<EnrolledIdentity | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('C');
  const [role, setRole] = useState<Role>('payer');

  const handleEnroll = useCallback(async () => {
    setEnrolling(true);
    setError(null);
    try {
      const enrolled = await enrollDevice(email);
      setIdentity(enrolled);
      // Opportunistic first fetch -- the device is online right now (it just
      // enrolled), the best possible moment to grab a fresh token before any
      // later offline period.
      const token = await fetchFreshnessToken(enrolled.deviceId);
      const { issued_at } = decodeFreshnessToken(decodeCoseSign1Unverified(base64ToBytes(token)).payload);
      await cacheFreshnessToken(enrolled.deviceId, token, issued_at);
    } catch (err) {
      setError(String(err));
    } finally {
      setEnrolling(false);
    }
  }, [email]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>TapPay Offline Modes (M2)</Text>

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
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {identity && (
        <>
          <SegmentedRow label="Mode" options={['B', 'C'] as const} value={mode} onChange={setMode} />
          <SegmentedRow label="Role" options={['payee', 'payer'] as const} value={role} onChange={setRole} />

          {mode === 'B' && role === 'payee' && <ModeBPayee identity={identity} />}
          {mode === 'B' && role === 'payer' && <ModeBPayer identity={identity} />}
          {mode === 'C' && role === 'payer' && <ModeCPayer identity={identity} />}
          {mode === 'C' && role === 'payee' && <ModeCPayee identity={identity} />}
        </>
      )}
    </ScrollView>
  );
}

// --- Mode B: sender-online bridge -----------------------------------------
// Same 3-QR shape as Mode A (TapScreen.tsx), with steps 3/4 swapped: here the
// PAYER is online and calls /tx/submit directly (instead of the payee), then
// relays the receipt; the PAYEE verifies it locally and never touches the
// network -- the payee is the offline side in Mode B.

function ModeBPayee({ identity }: { identity: EnrolledIdentity }) {
  const [step, setStep] = useState<BPayeeStep>('idle');
  const [receiverNonce, setReceiverNonce] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settledAmount, setSettledAmount] = useState<{ amount: bigint; currency: string } | null>(null);

  const requestQr = useMemo(() => {
    if (!receiverNonce) return null;
    const bytes = encodeTxRequest({ recipientDeviceId: identity.deviceId, receiverNonce, ts: Date.now() });
    return bytesToQrString(bytes);
  }, [identity.deviceId, receiverNonce]);

  const handleStart = useCallback(() => {
    setReceiverNonce(Crypto.getRandomBytes(16));
    setStep('request');
  }, []);

  const handleReceiptReceived = useCallback((qrData: string) => {
    setError(null);
    try {
      const receiptBytes = qrStringToBytes(qrData);
      // The payee never calls the network in Mode B -- this verification
      // against the pinned server key IS the payee's only proof of settlement.
      const verified = verifyCoseSign1(receiptBytes, getServerPublicKeyBytes());
      if (!verified) throw new Error('receipt signature does not verify against the pinned server key');
      const receipt = decodeTxReceipt(verified.payload);
      setSettledAmount({ amount: receipt.amount, currency: receipt.currency });
      setStep('settled');
    } catch (err) {
      setError(String(err));
      setStep('scan-receipt');
    }
  }, []);

  return (
    <View style={styles.section}>
      {error && <Text style={styles.error}>{error}</Text>}
      {step === 'idle' && (
        <TouchableOpacity style={styles.button} onPress={handleStart}>
          <Text style={styles.buttonText}>Request payment (I am offline)</Text>
        </TouchableOpacity>
      )}
      {step === 'request' && requestQr && (
        <>
          <QrWithCopyableText value={requestQr} />
          <TouchableOpacity style={styles.button} onPress={() => setStep('scan-receipt')}>
            <Text style={styles.buttonText}>Payer submitted it -- scan their receipt</Text>
          </TouchableOpacity>
        </>
      )}
      {step === 'scan-receipt' && <ScanStep label="Scan the payer's Receipt QR" onManualSubmit={handleReceiptReceived} />}
      {step === 'settled' && settledAmount && (
        <Text style={styles.settledText}>
          SETTLED -- {settledAmount.amount.toString()} {settledAmount.currency}
        </Text>
      )}
    </View>
  );
}

function ModeBPayer({ identity }: { identity: EnrolledIdentity }) {
  const [step, setStep] = useState<BPayerStep>('idle');
  const [scannedRequest, setScannedRequest] = useState<TxRequest | null>(null);
  const [amountInput, setAmountInput] = useState('100');
  const [receiptQr, setReceiptQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRequestReceived = useCallback((qrData: string) => {
    setError(null);
    try {
      setScannedRequest(decodeTxRequest(qrStringToBytes(qrData)));
      setStep('amount');
    } catch (err) {
      setError(String(err));
      setStep('scan-request');
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!scannedRequest) return;
    setError(null);
    try {
      const proposal: TxProposal = {
        tx_uuid: uuidToBytes(uuidv4()),
        sender_device_id: uuidToBytes(identity.deviceId),
        recipient_device_id: uuidToBytes(scannedRequest.recipientDeviceId),
        amount: BigInt(amountInput),
        currency: 'MAD',
        receiver_nonce: scannedRequest.receiverNonce,
        ts: Date.now(),
      };
      const payload = encodeTxProposal(proposal);
      // Biometric prompt happens here, same as every other signing path.
      const coseBytes = await signCoseSign1(payload, createIdentitySigner(identity.deviceId));

      // The PAYER is the one online in Mode B -- submits directly, unlike Mode
      // A where the payee does this.
      const res = await fetch(`${SERVER_BASE_URL}/tx/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cose_sign1: bytesToBase64(coseBytes) }),
      });
      const body = (await res.json()) as { receipt?: string; message?: string; error?: string };
      if (!res.ok || !body.receipt) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);

      setReceiptQr(bytesToQrString(qrStringToBytes(body.receipt)));
      setStep('done');
    } catch (err) {
      setError(String(err));
    }
  }, [identity, scannedRequest, amountInput]);

  return (
    <View style={styles.section}>
      {error && <Text style={styles.error}>{error}</Text>}
      {step === 'idle' && (
        <TouchableOpacity style={styles.button} onPress={() => setStep('scan-request')}>
          <Text style={styles.buttonText}>Scan a payment request (I am online)</Text>
        </TouchableOpacity>
      )}
      {step === 'scan-request' && <ScanStep label="Scan the payee's Request QR" onManualSubmit={handleRequestReceived} />}
      {step === 'amount' && scannedRequest && (
        <View style={styles.section}>
          <Text style={styles.stepLabel}>Recipient: {scannedRequest.recipientDeviceId.slice(0, 8)}</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Amount (centimes)</Text>
            <TextInput style={styles.input} value={amountInput} onChangeText={setAmountInput} keyboardType="number-pad" />
          </View>
          <TouchableOpacity style={styles.button} onPress={() => void handleSubmit()}>
            <Text style={styles.buttonText}>Sign + submit (biometric prompt)</Text>
          </TouchableOpacity>
        </View>
      )}
      {step === 'done' && receiptQr && (
        <>
          <Text style={styles.settledText}>SETTLED (server confirmed)</Text>
          <Text style={styles.rowLabel}>Relay this receipt to the offline payee:</Text>
          <QrWithCopyableText value={receiptQr} />
        </>
      )}
    </View>
  );
}

// --- Mode C: both offline, signed IOU --------------------------------------
// The PAYER's side is the side that actually moves money once reconnected --
// the exit gate ("airplane-mode tap creates a local IOU; reconnect settles it
// on the ledger") only ever required the payer's device to sync. The PAYEE's
// mirrored local persistence below (ModeCPayee) is real but necessarily
// limited: the payee's phone has no way to independently verify a peer's
// identity-key signature (only the server can), so it can only ever locally
// record "I was told this is coming" (amber INCOMING) until it independently
// checks GET /tx/:txUuid/receipt and verifies a real server-signed receipt --
// the same verification Mode B's payee already does -- before ever showing
// green.

function ModeCPayer({ identity }: { identity: EnrolledIdentity }) {
  const [step, setStep] = useState<CPayerStep>('idle');
  const [recipientDeviceId, setRecipientDeviceId] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState('100');
  const [warningAcked, setWarningAcked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingIntent[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [infoQrFor, setInfoQrFor] = useState<string | null>(null);

  const refreshPending = useCallback(async () => {
    setPending(await listRecentIntents(identity.deviceId));
  }, [identity.deviceId]);

  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  const handleRecipientScanned = useCallback(
    (data: string) => {
      setError(null);
      const trimmed = data.trim();
      if (!/^[0-9a-f-]{36}$/i.test(trimmed)) {
        setError('expected a raw device_id (UUID) -- see the recipient\'s "My device ID" QR');
        return;
      }
      if (trimmed.toLowerCase() === identity.deviceId.toLowerCase()) {
        // The server rejects this too (journal's UNIQUE (tx_uuid, account_id)
        // makes self-transfer structurally impossible), but catching it here
        // means the user never gets as far as a biometric prompt for a send
        // that can never settle.
        setError("that's your own device ID -- you can't send to yourself");
        return;
      }
      setRecipientDeviceId(trimmed);
      setStep('amount');
    },
    [identity.deviceId],
  );

  const handleSignAndQueue = useCallback(async () => {
    if (!recipientDeviceId) return;
    setError(null);
    try {
      let cached = await getCachedFreshnessToken(identity.deviceId);
      if (!cached || Date.now() - cached.issuedAt > FRESHNESS_TOKEN_TTL_MS / 2) {
        // Proactive refresh at the halfway point, not just when already
        // expired -- avoids ever handing the user a token that's about to
        // lapse mid-offline-period. Requires being online right now.
        const token = await fetchFreshnessToken(identity.deviceId);
        const { issued_at } = decodeFreshnessToken(decodeCoseSign1Unverified(base64ToBytes(token)).payload);
        await cacheFreshnessToken(identity.deviceId, token, issued_at);
        cached = { token, issuedAt: issued_at };
      }
      if (Date.now() - cached.issuedAt > FRESHNESS_TOKEN_TTL_MS) {
        throw new Error('freshness token is more than 24h old and this device has no connectivity to refresh it -- cannot send offline right now');
      }

      const seq = await getNextSeq(identity.deviceId);
      const txUuid = uuidv4();
      const iou: OfflineIou = {
        tx_uuid: uuidToBytes(txUuid),
        sender_device_id: uuidToBytes(identity.deviceId),
        recipient_device_id: uuidToBytes(recipientDeviceId),
        amount: BigInt(amountInput),
        currency: 'MAD',
        seq,
        ts: Date.now(),
      };
      // Biometric prompt -- same signer as every other signing path in this app.
      const coseBytes = await signCoseSign1(encodeOfflineIou(iou), createIdentitySigner(identity.deviceId));

      await insertPendingIntent({
        txUuid,
        deviceId: identity.deviceId,
        coseIou: bytesToBase64(coseBytes),
        freshnessToken: cached.token,
        recipientDeviceId,
        amount: iou.amount,
        currency: iou.currency,
        seq,
      });

      setStep('idle');
      setRecipientDeviceId(null);
      setWarningAcked(false);
      await refreshPending();
    } catch (err) {
      setError(String(err));
    }
  }, [identity, recipientDeviceId, amountInput, refreshPending]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const toSync = await listPendingIntents(identity.deviceId);
      if (toSync.length === 0) return;

      const res = await fetch(`${SERVER_BASE_URL}/tx/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: identity.deviceId,
          intents: toSync.map((intent) => ({ cose_iou: intent.coseIou, freshness_token: intent.freshnessToken })),
        }),
      });
      const body = (await res.json()) as {
        results?: { tx_uuid: string | null; status: PendingIntent['syncStatus']; receipt?: string }[];
        message?: string;
      };
      if (!res.ok || !body.results) throw new Error(body.message ?? `HTTP ${res.status}`);

      for (const result of body.results) {
        if (result.tx_uuid) {
          await markSyncResult(result.tx_uuid, result.status, result.receipt);
        }
      }
      await refreshPending();
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncing(false);
    }
  }, [identity.deviceId, refreshPending]);

  return (
    <View style={styles.section}>
      {error && <Text style={styles.error}>{error}</Text>}

      <Text style={styles.stepLabel}>My device ID (share with the recipient):</Text>
      <QrWithCopyableText value={identity.deviceId} />

      {step === 'idle' && (
        <TouchableOpacity style={styles.button} onPress={() => setStep('scan-recipient')}>
          <Text style={styles.buttonText}>Send offline (Mode C)</Text>
        </TouchableOpacity>
      )}
      {step === 'scan-recipient' && (
        <ScanStep label="Scan/paste the recipient's device ID" onManualSubmit={handleRecipientScanned} />
      )}
      {step === 'amount' && recipientDeviceId && (
        <View style={styles.section}>
          <Text style={styles.stepLabel}>Recipient: {recipientDeviceId.slice(0, 8)}</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Amount (centimes)</Text>
            <TextInput style={styles.input} value={amountInput} onChangeText={setAmountInput} keyboardType="number-pad" />
          </View>
          <TouchableOpacity style={styles.button} onPress={() => setStep('confirm')}>
            <Text style={styles.buttonText}>Continue</Text>
          </TouchableOpacity>
        </View>
      )}
      {step === 'confirm' && (
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>You are sending without the bank's confirmation</Text>
          <Text style={styles.warningText}>
            This is a signed promise, not a completed transfer. If it fails to sync later (insufficient funds, expired
            token), you bear the loss until it settles. Nothing is final until this device reconnects and syncs.
          </Text>
          <View style={styles.row}>
            <Switch value={warningAcked} onValueChange={setWarningAcked} />
            <Text style={styles.rowLabel}>I understand the risk</Text>
          </View>
          <TouchableOpacity
            style={[styles.button, !warningAcked && styles.buttonDisabled]}
            disabled={!warningAcked}
            onPress={() => void handleSignAndQueue()}
          >
            <Text style={styles.buttonText}>Sign (biometric prompt) & queue offline</Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={styles.stepLabel}>Pending / recent local intents</Text>
      {pending.length === 0 && <Text style={styles.readoutText}>none</Text>}
      {pending.map((intent) => (
        <View key={intent.txUuid} style={styles.section}>
          <View style={styles.row}>
            <Text style={[styles.readoutText, { color: statusColor(intent.syncStatus) }]}>
              {/* PENDING_INTENT is shown amber, full stop -- never green until the
                  server response above actually says SETTLED. */}
              {intent.syncStatus === 'PENDING' ? 'PENDING_INTENT' : intent.syncStatus} -- {intent.amount} {intent.currency} to{' '}
              {intent.recipientDeviceId.slice(0, 8)}
            </Text>
            {intent.syncStatus === 'PENDING' && (
              <TouchableOpacity
                style={styles.smallButton}
                onPress={() => setInfoQrFor(infoQrFor === intent.txUuid ? null : intent.txUuid)}
              >
                <Text style={styles.smallButtonText}>{infoQrFor === intent.txUuid ? 'Hide' : 'Info QR'}</Text>
              </TouchableOpacity>
            )}
          </View>
          {infoQrFor === intent.txUuid && (
            <>
              <Text style={styles.readoutText}>
                Unsigned, informational only -- lets the recipient locally track this incoming send. Never proof of
                payment on its own.
              </Text>
              <QrWithCopyableText
                value={bytesToQrString(
                  encodeIncomingIouInfo({
                    tx_uuid: uuidToBytes(intent.txUuid),
                    sender_device_id: uuidToBytes(identity.deviceId),
                    amount: BigInt(intent.amount),
                    currency: intent.currency,
                  }),
                )}
              />
            </>
          )}
        </View>
      ))}
      <TouchableOpacity
        style={[styles.button, (syncing || pending.every((p) => p.syncStatus !== 'PENDING')) && styles.buttonDisabled]}
        onPress={() => void handleSync()}
        disabled={syncing || pending.every((p) => p.syncStatus !== 'PENDING')}
      >
        <Text style={styles.buttonText}>{syncing ? 'Syncing…' : 'Reconnect & Sync'}</Text>
      </TouchableOpacity>
    </View>
  );
}

type CPayeeStep = 'idle' | 'scan-info';

function ModeCPayee({ identity }: { identity: EnrolledIdentity }) {
  const [step, setStep] = useState<CPayeeStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<IncomingIntent[]>([]);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const refreshIncoming = useCallback(async () => {
    setIncoming(await listIncomingIntents(identity.deviceId));
  }, [identity.deviceId]);

  useEffect(() => {
    void refreshIncoming();
  }, [refreshIncoming]);

  const handleInfoScanned = useCallback(
    async (data: string) => {
      setError(null);
      try {
        const info = decodeIncomingIouInfo(qrStringToBytes(data));
        await insertIncomingIntent({
          txUuid: bytesToUuid(info.tx_uuid),
          deviceId: identity.deviceId,
          senderDeviceId: bytesToUuid(info.sender_device_id),
          amount: info.amount,
          currency: info.currency,
        });
        setStep('idle');
        await refreshIncoming();
      } catch (err) {
        setError(String(err));
        setStep('scan-info');
      }
    },
    [identity.deviceId, refreshIncoming],
  );

  const handleCheckStatus = useCallback(
    async (txUuid: string) => {
      setError(null);
      setCheckingId(txUuid);
      try {
        const res = await fetch(`${SERVER_BASE_URL}/tx/${txUuid}/receipt`);
        if (res.status === 404) return; // not settled yet -- stays INCOMING, not an error
        const body = (await res.json()) as { receipt?: string; message?: string };
        if (!res.ok || !body.receipt) throw new Error(body.message ?? `HTTP ${res.status}`);

        // The only independently-verifiable proof of settlement this screen
        // has: a real server-signed receipt against the pinned server key --
        // same check ModeBPayee does. The incoming info alone is never enough.
        const verified = verifyCoseSign1(base64ToBytes(body.receipt), getServerPublicKeyBytes());
        if (!verified) throw new Error("receipt signature does not verify against the pinned server key");
        decodeTxReceipt(verified.payload); // decodes cleanly or throws -- confirms it's a real TxReceipt

        await markIncomingSettled(txUuid, body.receipt);
        await refreshIncoming();
      } catch (err) {
        setError(String(err));
      } finally {
        setCheckingId(null);
      }
    },
    [refreshIncoming],
  );

  return (
    <View style={styles.section}>
      {error && <Text style={styles.error}>{error}</Text>}

      {step === 'idle' && (
        <TouchableOpacity style={styles.button} onPress={() => setStep('scan-info')}>
          <Text style={styles.buttonText}>Scan an incoming payment's info QR</Text>
        </TouchableOpacity>
      )}
      {step === 'scan-info' && <ScanStep label="Scan the payer's info QR" onManualSubmit={(data) => void handleInfoScanned(data)} />}

      <Text style={styles.stepLabel}>Incoming (unconfirmed until checked)</Text>
      {incoming.length === 0 && <Text style={styles.readoutText}>none</Text>}
      {incoming.map((intent) => (
        <View key={intent.txUuid} style={styles.row}>
          <Text style={[styles.readoutText, { color: incomingStatusColor(intent.status) }]}>
            {/* INCOMING is amber, full stop -- it's only ever a claim the payer
                made, never a fact this phone can verify on its own. */}
            {intent.status} -- {intent.amount} {intent.currency} from {intent.senderDeviceId.slice(0, 8)}
          </Text>
          {intent.status === 'INCOMING' && (
            <TouchableOpacity
              style={[styles.smallButton, checkingId === intent.txUuid && styles.buttonDisabled]}
              disabled={checkingId === intent.txUuid}
              onPress={() => void handleCheckStatus(intent.txUuid)}
            >
              <Text style={styles.smallButtonText}>{checkingId === intent.txUuid ? 'Checking…' : 'Check status'}</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
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
  error: { color: '#ff6b6b' },
  readout: { padding: 12, backgroundColor: '#1b1b1b', borderRadius: 8, gap: 4 },
  readoutText: { color: '#ccc', fontFamily: 'monospace' },
  button: { backgroundColor: '#4ea8ff', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  buttonDisabled: { backgroundColor: '#2a2a2a' },
  buttonText: { color: '#111', fontWeight: '700', fontSize: 15 },
  section: { gap: 8 },
  stepLabel: { color: '#eee', fontWeight: '600' },
  settledText: { color: '#4eff8a', fontWeight: '700', fontSize: 18, textAlign: 'center' },
  warningBox: { gap: 10, padding: 14, backgroundColor: '#2a1f0a', borderRadius: 8, borderWidth: 1, borderColor: '#e0b03d' },
  warningTitle: { color: '#e0b03d', fontWeight: '700', fontSize: 15 },
  warningText: { color: '#ddd', fontSize: 13 },
});
