import {
  bytesToUuid,
  classifyPeerPayload,
  ConnectivityMode,
  decodeCoseSign1Unverified,
  decodeFreshnessToken,
  encodeIncomingIouInfo,
  evaluateConnectivity,
  formatMinorUnits,
  parseMinorUnits,
  uuidToBytes,
  type TxRequest,
} from '@tappay/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { IdentityHeader } from '../components/IdentityHeader';
import { QrWithCopyableText, ScanStep, SegmentedRow } from '../components/qrFlow';
import { getServerPublicKeyBytes } from '../config/serverPublicKey';
import { enrollDevice, fetchAndCacheOwnCredential, fetchFreshnessToken, type EnrolledIdentity } from '../crypto/identity';
import {
  cacheFreshnessToken,
  insertIncomingIntent,
  listIncomingIntents,
  listRecentIntents,
  type IncomingIntent,
  type PendingIntent,
} from '../db/offlineIntents';
import { probeServerReachable } from '../net/connectivity';
import {
  advertiseAndAwaitSession,
  closeBleRadioConnection,
  completeBleHandshake,
  connectAndEstablishSession,
  connectBleRadio,
  type BleRadioConnection,
  type BleSession,
} from '../payments/bleTransport';
import {
  buildSignedProposal,
  fetchBalance,
  generatePaymentRequest,
  pollIncomingReceipt,
  signAndQueueIou,
  submitProposal,
  syncPendingIntents,
  verifyServerReceipt,
} from '../payments/paymentFlow';
import { bytesToQrString, qrStringToBytes } from '../transport/qr';
import { base64ToBytes } from '../../util/base64';

/**
 * M3 Milestone 2, Phase D: submits a proposal and verifies the resulting
 * receipt against `request`, independent of any component's closure state --
 * both the QR-scanned path (`submitScannedProposal`, which reads `myRequest`
 * from state) and the BLE background handler (which captures `request` as a
 * local const from the exact `generatePaymentRequest` call that produced it)
 * call this. The BLE path deliberately does NOT read `myRequest` state: the
 * session's `onMessage` callback can fire well after the closure that
 * registered it was created, and by then `myRequest` may have changed (or
 * the user may have started a new request) -- capturing `request` as a
 * plain value at BLE-advertise time sidesteps that stale-closure risk
 * entirely, the same reason `SessionDemoScreen.tsx`'s hello exchange avoids
 * reading peer state that might not reflect what was actually used to
 * derive a key.
 */
async function submitAndVerifyProposal(request: TxRequest, bytes: Uint8Array) {
  const receiptBytes = await submitProposal(bytes);
  const receipt = verifyServerReceipt(receiptBytes, {
    recipientDeviceId: request.recipient_device_id,
    receiverNonce: request.receiver_nonce,
  });
  return { receiptBytes, receipt };
}

/** Resolves with the next plaintext message on `session`, or rejects on
 * timeout -- the Mode A BLE path's analogue of "scan the payee's Receipt
 * QR," just waiting on a sealed reply instead of a camera frame. */
function waitForBleMessage(session: BleSession, timeoutMs = 15_000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for a BLE reply'));
    }, timeoutMs);
    unsubscribe = session.onMessage((plaintext) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(plaintext);
    });
  });
}

/**
 * The unified Send/Receive payment flow (Phase 5), replacing TapScreen.tsx
 * (Mode A only) and OfflineScreen.tsx (Mode B/C, manual mode toggle) with one
 * screen that AUTO-DETECTS which of the three connectivity modes applies,
 * via @tappay/shared's evaluateConnectivity -- the user never picks a mode by
 * hand. QR remains the standing transport (bump/BLE is M3, not built yet;
 * this is designed to be a drop-in swap later, not a permanent architecture).
 *
 * Mode selection has a real constraint pre-BLE: no wire signal exists for one
 * phone to learn the other's connectivity ahead of time. Resolved the same
 * way for both sides of the exchange:
 *  - senderOnline: this device's own live probeServerReachable() result.
 *  - receiverOnline: the OTHER device's self-assessed claim, stamped into
 *    the Request QR's receiver_online field when THEY generated it. A hint,
 *    never trusted for anything security-relevant (every mode stays
 *    independently safe regardless of what it claims, per the tx_uuid
 *    conflict guard and receipt-binding checks) -- it only picks a
 *    choreography.
 *
 * Every "scan" step still has a manual paste fallback (CLAUDE.md §7 -- do
 * not remove; this is currently the only way to exercise a two-party
 * protocol without a second phone reachable in this dev session).
 *
 * M3 Milestone 2 (Phase D): BLE is now attempted FIRST, QR remains the
 * always-available fallback -- never a hard replacement. The receive side
 * starts advertising in the background the moment a request is generated;
 * the send side starts connecting in the background the moment a request is
 * scanned (Mode A/B only -- Mode C, both offline, stays QR/local-queue only,
 * per the Milestone 2 plan). Both attempts fail silently into the unchanged
 * QR steps below if BLE never connects in time -- no screen error, no
 * blocked UI, exactly the risk-reducing design the plan called for. Neither
 * attempt changes what's trusted or how settlement works: BLE only carries
 * the same signed proposal/receipt bytes the QR steps already carry, sealed
 * via the authenticated ECDH session layer (`payments/bleTransport.ts`).
 */

type Role = 'receive' | 'send';
type ReceiveStep = 'idle' | 'showing-request' | 'awaiting-peer-payload' | 'settled';
type SendStep = 'idle' | 'scan-request' | 'amount' | 'proposal-shown' | 'awaiting-receipt' | 'confirm-offline' | 'settled';

function statusColor(status: PendingIntent['syncStatus']): string {
  if (status === 'SETTLED') return '#4eff8a';
  if (status === 'PENDING') return '#e0b03d';
  return '#ff6b6b'; // every FAILED_* status
}

function incomingStatusColor(status: IncomingIntent['status']): string {
  // SETTLED here is set ONLY after independently verifying a real server
  // receipt (markIncomingSettled's doc comment) -- INCOMING is amber, full
  // stop, same amber-until-proven-green discipline as the send side's
  // PENDING_INTENT list. CLAUDE.md's Mode C rule: never a green checkmark
  // until server settlement, and this applies to the payee's side too.
  return status === 'SETTLED' ? '#4eff8a' : '#e0b03d';
}

type BleStatus = 'idle' | 'connecting' | 'connected' | 'unavailable';

function bleStatusLabel(status: BleStatus): string | null {
  if (status === 'connecting') return 'BLE: connecting…';
  if (status === 'connected') return 'BLE: connected -- will skip the QR relay steps';
  if (status === 'unavailable') return 'BLE: unavailable -- using QR';
  return null; // idle -- nothing attempted yet, no readout
}

function bleStatusColor(status: BleStatus): string {
  if (status === 'connected') return '#4eff8a';
  if (status === 'unavailable') return '#888';
  return '#e0b03d'; // connecting
}

export default function PayScreen() {
  const [email, setEmail] = useState('alice@tappay.local');
  const [identity, setIdentity] = useState<EnrolledIdentity | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('receive');

  const [online, setOnline] = useState<boolean | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);

  const refreshBalance = useCallback(async () => {
    if (!identity) return;
    try {
      setBalance(await fetchBalance(identity.accountId));
    } catch {
      // Balance readout is informational -- a transient failure here
      // shouldn't block or error out the rest of the screen.
    }
  }, [identity]);

  const refreshConnectivity = useCallback(async () => {
    setOnline(await probeServerReachable());
  }, []);

  useEffect(() => {
    void refreshConnectivity();
    // A single mount-time probe goes stale the moment real connectivity
    // changes (e.g. WiFi toggled off) -- nothing else was re-triggering it,
    // so the badge could show "online" indefinitely after actually going
    // offline. Re-probe periodically so it's a live gauge, not a one-shot
    // snapshot. 5s -- comfortably above probeServerReachable's own 1500ms
    // timeout so probes never overlap, frequent enough to feel live.
    const interval = setInterval(() => void refreshConnectivity(), 5000);
    return () => clearInterval(interval);
  }, [refreshConnectivity]);

  useEffect(() => {
    if (identity) void refreshBalance();
  }, [identity, refreshBalance]);

  // M3 Milestone 2: the active best-effort BLE session for each role, if one
  // ever established. Refs, not state -- a BleSession isn't renderable UI
  // data, and closing it must never depend on a re-render happening first.
  // A background connect/advertise attempt that resolves AFTER the user has
  // already reset the flow is a known, accepted edge case (the next
  // resetFlow/unmount still closes it) rather than a fully cancellation-
  // token-guarded path -- this is a best-effort background enhancement, not
  // a correctness-critical one; QR is what settlement actually depends on.
  const bleReceiveSessionRef = useRef<BleSession | null>(null);
  const bleSendSessionRef = useRef<BleSession | null>(null);
  // Mode A only (M3 Milestone 3): a radio-only connection established in the
  // background right after scanning the Request QR, with the actual
  // cryptographic handshake (and its biometric prompt) deferred until
  // "Sign" is tapped -- see handleRequestScanned/handleContinue and
  // connectBleRadio's own doc comment for why.
  const bleRadioConnectionRef = useRef<BleRadioConnection | null>(null);

  // Visible readout of the background BLE attempt -- found missing during
  // Milestone 2 live-testing: the original background
  // advertiseAndAwaitSession/connectAndEstablishSession calls swallowed
  // failure with a bare `.catch(() => {})` and no success log either, so a
  // failed (or even attempted) connection left literally zero trace in
  // logcat and no on-screen signal, making a real bug (a dropped `adb
  // reverse` tunnel breaking fetchPeerCredential) indistinguishable from
  // "BLE never tried." Every transition now also gets a console.log/warn --
  // cheap, and the only way to tell the two apart from a logcat pull during
  // live testing without this screen itself growing a debug console.
  const [bleStatus, setBleStatus] = useState<BleStatus>('idle');

  const closeBleSessions = useCallback(() => {
    bleReceiveSessionRef.current?.close();
    bleReceiveSessionRef.current = null;
    bleSendSessionRef.current?.close();
    bleSendSessionRef.current = null;
    if (bleRadioConnectionRef.current) {
      closeBleRadioConnection(bleRadioConnectionRef.current);
      bleRadioConnectionRef.current = null;
    }
    setBleStatus('idle');
  }, []);

  useEffect(() => closeBleSessions, [closeBleSessions]);

  const handleEnroll = useCallback(async () => {
    setEnrolling(true);
    setError(null);
    try {
      const enrolled = await enrollDevice(email);
      setIdentity(enrolled);
      // Opportunistic first freshness-token fetch -- the device is online
      // right now (it just enrolled), the best possible moment to grab one
      // before any later offline period (Mode C needs it).
      try {
        const token = await fetchFreshnessToken(enrolled.deviceId);
        const { issued_at } = decodeFreshnessToken(decodeCoseSign1Unverified(base64ToBytes(token)).payload);
        await cacheFreshnessToken(enrolled.deviceId, token, issued_at);
      } catch {
        // Non-fatal -- signAndQueueIou fetches its own fresh token on demand
        // if this opportunistic cache attempt didn't happen.
      }
      // Same opportunistic-while-online reasoning, for M3 Milestone 3's own
      // device credential -- bleTransport.ts fails closed to the QR fallback
      // if this was never cached (a rare, first-run-only edge).
      try {
        await fetchAndCacheOwnCredential(enrolled.deviceId);
      } catch {
        // Non-fatal -- BLE simply stays unavailable until this succeeds once.
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setEnrolling(false);
    }
  }, [email]);

  // --- Receive side ---

  const [receiveStep, setReceiveStep] = useState<ReceiveStep>('idle');
  const [myRequest, setMyRequest] = useState<TxRequest | null>(null);
  const [requestQr, setRequestQr] = useState<string | null>(null);
  const [settledReceipt, setSettledReceipt] = useState<{ amount: bigint; currency: string; qr: string } | null>(null);
  const [retryBytes, setRetryBytes] = useState<Uint8Array | null>(null); // last scanned proposal, for the A/B resubmission retry
  const [incoming, setIncoming] = useState<IncomingIntent[]>([]);

  const refreshIncoming = useCallback(async () => {
    if (!identity) return;
    setIncoming(await listIncomingIntents(identity.deviceId));
  }, [identity]);

  useEffect(() => {
    if (identity) void refreshIncoming();
  }, [identity, refreshIncoming]);

  const handleStartRequest = useCallback(async () => {
    if (!identity) return;
    setError(null);
    try {
      const { request, qr } = await generatePaymentRequest(identity);
      setMyRequest(request);
      setRequestQr(qr);
      setReceiveStep('showing-request');

      // Best-effort BLE (M3 Milestone 2): the QR just shown above stays the
      // always-available fallback regardless of what happens here. `request`
      // is captured as a plain local value, not read back from `myRequest`
      // state, deliberately -- see submitAndVerifyProposal's doc comment.
      setBleStatus('connecting');
      advertiseAndAwaitSession(identity)
        .then((session) => {
          console.log('[BLE] advertiseAndAwaitSession established, peer', session.peerDeviceId);
          bleReceiveSessionRef.current = session;
          setBleStatus('connected');
          session.onMessage((plaintext) => {
            void (async () => {
              try {
                const classified = classifyPeerPayload(plaintext, getServerPublicKeyBytes());
                if (classified.kind !== 'proposal') return; // ignore anything else on this channel
                const { receiptBytes, receipt } = await submitAndVerifyProposal(request, plaintext);
                setSettledReceipt({ amount: receipt.amount, currency: receipt.currency, qr: bytesToQrString(receiptBytes) });
                setReceiveStep('settled');
                setRetryBytes(null);
                void refreshBalance();
                // Best-effort direct relay back to the payer over the same
                // session -- if this fails, the payer's own QR-scan step
                // (still fully available) is the fallback, not this.
                await session.send(receiptBytes);
              } catch (err) {
                setError(String(err));
              } finally {
                // Close right away rather than leaving the link open until
                // the next resetFlow/role-switch -- found live that a
                // dangling settled session's eventual (Android BLE
                // disconnect confirmation is asynchronous and can arrive
                // tens of seconds late) teardown could bleed into a
                // subsequently-started fresh attempt. See
                // resetNativeBleState's doc comment in bleTransport.ts.
                session.close();
                if (bleReceiveSessionRef.current === session) bleReceiveSessionRef.current = null;
              }
            })();
          });
        })
        .catch((err) => {
          // BLE unavailable/timed out/failed -- the QR step already shown
          // above is the real fallback path, so this never surfaces as a
          // screen error. It's still logged (not swallowed silently) so a
          // failure is distinguishable from "never tried" during live
          // testing -- see bleStatus's own doc comment for why this matters.
          console.warn('[BLE] advertiseAndAwaitSession failed, falling back to QR:', err);
          setBleStatus('unavailable');
        });
    } catch (err) {
      setError(String(err));
    }
  }, [identity, refreshBalance]);

  const submitScannedProposal = useCallback(
    async (bytes: Uint8Array) => {
      // /tx/submit settles ANY validly-signed proposal regardless of who
      // submits it -- the payee here is just a relay/submitter, not a party
      // the server verifies against the caller. Forwarding an attacker's
      // proposal (even a self-payment between two attacker-controlled
      // devices, requiring no interaction with the real recipient at all)
      // would settle legitimately and return a genuinely server-signed
      // receipt -- for the ATTACKER's transaction, not this device's. Bind
      // it to the request THIS device generated, exactly like the 'receipt'
      // (Mode B relay) branch below, or that receipt is a bearer token all
      // over again (CLAUDE.md §5 -- the exact issue TxReceipt's binding
      // fields exist to close). Found via /security-review.
      if (!myRequest) throw new Error('no request was generated in this session -- start over');
      const { receiptBytes, receipt } = await submitAndVerifyProposal(myRequest, bytes);
      setSettledReceipt({ amount: receipt.amount, currency: receipt.currency, qr: bytesToQrString(receiptBytes) });
      setReceiveStep('settled');
      setRetryBytes(null);
      void refreshBalance();
    },
    [myRequest, refreshBalance],
  );

  const handlePeerPayloadScanned = useCallback(
    async (qrData: string) => {
      setError(null);
      // Cleared up front, not just on success -- a stale retryBytes from an
      // earlier failed proposal scan must not linger and offer "Retry" for
      // bytes unrelated to whatever was just scanned this time.
      setRetryBytes(null);
      try {
        const bytes = qrStringToBytes(qrData);
        const classified = classifyPeerPayload(bytes, getServerPublicKeyBytes());

        if (classified.kind === 'proposal') {
          // Mode A: the payer scanned my request, signed a proposal, and is
          // showing ME that proposal QR. Forward the raw bytes to
          // /tx/submit untouched -- deliberately not verified client-side
          // (classifyPeerPayload's doc comment: this device has no way to
          // look up an arbitrary payer's identity_pubkey; the server is the
          // actual verification boundary).
          setRetryBytes(bytes);
          await submitScannedProposal(bytes);
          return;
        }

        if (classified.kind === 'receipt') {
          // Mode B: the payer already submitted directly (they're online)
          // and is relaying me, the offline payee, the receipt. This IS an
          // untrusted peer relay -- bind it to the request I generated, or
          // any old settled receipt of the right shape would satisfy a bare
          // signature check (TxReceipt's doc comment).
          if (!myRequest) throw new Error('no request was generated in this session -- start over');
          const receipt = verifyServerReceipt(bytes, {
            recipientDeviceId: myRequest.recipient_device_id,
            receiverNonce: myRequest.receiver_nonce,
          });
          setSettledReceipt({ amount: receipt.amount, currency: receipt.currency, qr: bytesToQrString(bytes) });
          setReceiveStep('settled');
          void refreshBalance();
          return;
        }

        if (classified.kind === 'iou_info') {
          // Mode C: an informational-only claim ("I signed you an offline
          // IOU") -- unsigned, never proof of anything (CLAUDE.md §5). Amber
          // INCOMING only; the persistent Incoming list below is the only
          // place this can ever go green, and only after independently
          // fetching+verifying a real server receipt.
          if (!identity) return;
          await insertIncomingIntent({
            txUuid: bytesToUuid(classified.info.tx_uuid),
            deviceId: identity.deviceId,
            senderDeviceId: bytesToUuid(classified.info.sender_device_id),
            amount: classified.info.amount,
            currency: classified.info.currency,
          });
          setReceiveStep('idle');
          await refreshIncoming();
          return;
        }

        if (classified.kind === 'request') {
          // Not a response at all -- the payer's own screen is still
          // showing (or reset back to) a Request QR, meaning their attempt
          // didn't complete. Same recovery hint TapScreen.tsx originally
          // gave for this exact confusion.
          throw new Error(
            "that's a payment request, not a response -- the other device hasn't completed the payment yet. If they're stuck, have them start over.",
          );
        }

        throw new Error('unrecognized QR -- not a payment proposal, receipt, or offline-payment info QR');
      } catch (err) {
        setError(String(err));
        setReceiveStep('awaiting-peer-payload');
      }
    },
    [identity, myRequest, refreshBalance, refreshIncoming, submitScannedProposal],
  );

  const handleRetrySubmission = useCallback(async () => {
    if (!retryBytes) return;
    setError(null);
    try {
      // Same underlying operation Mode B's payer-side submission is --
      // resubmitting the byte-identical signed proposal is safe specifically
      // because transfer()'s tx_uuid idempotency (CLAUDE.md §5) makes this a
      // true retry, never a double-spend, regardless of which side submits.
      await submitScannedProposal(retryBytes);
    } catch (err) {
      setError(String(err));
    }
  }, [retryBytes, submitScannedProposal]);

  // --- Send side ---

  const [sendStep, setSendStep] = useState<SendStep>('idle');
  const [scannedRequest, setScannedRequest] = useState<TxRequest | null>(null);
  const [derivedMode, setDerivedMode] = useState<ConnectivityMode | null>(null);
  const [amountInput, setAmountInput] = useState('1.00');
  const [proposalQr, setProposalQr] = useState<string | null>(null);
  const [signedProposal, setSignedProposal] = useState<{ txUuid: Uint8Array; amount: bigint } | null>(null);
  const [sendSettled, setSendSettled] = useState<{ amount: bigint; currency: string; relayQr?: string } | null>(null);
  const [warningAcked, setWarningAcked] = useState(false);
  const [pending, setPending] = useState<PendingIntent[]>([]);
  const [infoQrFor, setInfoQrFor] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshPending = useCallback(async () => {
    if (!identity) return;
    setPending(await listRecentIntents(identity.deviceId));
  }, [identity]);

  useEffect(() => {
    if (identity) void refreshPending();
  }, [identity, refreshPending]);

  const handleRequestScanned = useCallback(
    async (qrData: string) => {
      setError(null);
      try {
        const bytes = qrStringToBytes(qrData);
        const classified = classifyPeerPayload(bytes, getServerPublicKeyBytes());
        if (classified.kind !== 'request') {
          throw new Error('expected a payment Request QR');
        }
        const request = classified.request;
        if (!identity) return;
        if (bytesToUuid(request.recipient_device_id) === identity.deviceId) {
          // The server rejects this too (journal's UNIQUE (tx_uuid,
          // account_id) makes self-transfer structurally impossible), but
          // catching it here means no biometric prompt for a send that can
          // never settle.
          throw new Error("that's your own device -- you can't pay yourself");
        }
        const senderOnline = await probeServerReachable();
        const mode = evaluateConnectivity(request.receiver_online, senderOnline);
        setScannedRequest(request);
        setDerivedMode(mode);
        setSendStep('amount');

        // Best-effort BLE (M3 Milestone 2), started now so it has the whole
        // amount-entry step's worth of time to connect before "Sign" is
        // tapped. Mode C (both offline) is explicitly excluded per the plan
        // -- it stays QR/local-queue-only; Mode A/B both attempt it since
        // "internet-offline" doesn't imply "Bluetooth-unreachable."
        if (mode === ConnectivityMode.MODE_A) {
          // Radio-only for now (M3 Milestone 3): the actual handshake --
          // and its biometric prompt -- is deferred to handleContinue's
          // Mode A branch, so it runs back-to-back with the payment
          // proposal's own sign call as ONE prompt instead of two. See
          // connectBleRadio's doc comment.
          setBleStatus('connecting');
          connectBleRadio(request.recipient_device_id)
            .then((connection) => {
              console.log('[BLE] radio connected, ready for handshake at Sign time');
              bleRadioConnectionRef.current = connection;
              setBleStatus('connected');
            })
            .catch((err) => {
              // BLE unavailable/timed out/failed -- the QR steps below stay
              // fully available and untouched. Logged, not swallowed
              // silently -- see bleStatus's own doc comment.
              console.warn('[BLE] connectBleRadio failed, falling back to QR:', err);
              setBleStatus('unavailable');
            });
        } else if (mode === ConnectivityMode.MODE_B) {
          // Mode B: unchanged from Milestone 2 -- connects AND completes the
          // handshake immediately (its own, separate biometric prompt),
          // since Mode B's payer submits directly rather than waiting on a
          // later explicit BLE-specific step to bundle the prompt with.
          setBleStatus('connecting');
          connectAndEstablishSession(identity, request.recipient_device_id)
            .then((session) => {
              console.log('[BLE] connectAndEstablishSession established, peer', session.peerDeviceId);
              bleSendSessionRef.current = session;
              setBleStatus('connected');
            })
            .catch((err) => {
              console.warn('[BLE] connectAndEstablishSession failed, falling back to QR:', err);
              setBleStatus('unavailable');
            });
        }
      } catch (err) {
        setError(String(err));
        setSendStep('scan-request');
      }
    },
    [identity],
  );

  const handleContinue = useCallback(async () => {
    if (!identity || !scannedRequest || !derivedMode) return;
    setError(null);
    try {
      // parseMinorUnits (packages/shared/src/money.ts) turns a user-entered
      // MAD amount like "1.50" into bigint centimes -- the input field is
      // labeled and typed in MAD to match every other amount shown on this
      // screen (balance, settled amounts, list amounts), never raw centimes.
      const amount = parseMinorUnits(amountInput);

      if (derivedMode === ConnectivityMode.MODE_C) {
        setSendStep('confirm-offline');
        return;
      }

      // M3 Milestone 3: for Mode A, complete any pending BLE handshake
      // BEFORE signing the proposal below -- this is the biometric prompt
      // the user sees, and the proposal's own sign call right after it
      // reuses the same KeyStore auth window (KeyStoreManager.kt) instead
      // of prompting again. Order matters: reversing it would open the
      // window on the wrong operation. Mode B doesn't need this (see
      // handleRequestScanned's Mode B branch, unchanged from Milestone 2 --
      // it completes its own handshake immediately in the background
      // instead, since Mode B's payer submits directly with no later
      // explicit BLE-specific step to bundle a prompt with).
      let bleSession: BleSession | null = null;
      if (derivedMode === ConnectivityMode.MODE_A) {
        const radioConnection = bleRadioConnectionRef.current;
        bleRadioConnectionRef.current = null; // consumed -- one attempt per connection
        if (radioConnection) {
          try {
            bleSession = await completeBleHandshake(identity, radioConnection);
            setBleStatus('connected');
          } catch (err) {
            console.warn('[BLE] handshake failed, falling back to QR:', err);
            setBleStatus('unavailable');
          }
        }
      }

      const { txUuid, coseBytes, qr } = await buildSignedProposal(identity, scannedRequest, amount);
      setSignedProposal({ txUuid, amount });

      if (derivedMode === ConnectivityMode.MODE_A) {
        // M3 Milestone 2: if a BLE session is ready (established just
        // above), skip the Proposal-QR/Receipt-QR manual steps entirely --
        // send the signed proposal sealed over BLE and await the sealed
        // receipt the same way. The PAYEE still submits (unchanged from the
        // QR path; see handleStartRequest's BLE proposal handler).
        if (bleSession) {
          try {
            await bleSession.send(coseBytes);
            const receiptBytes = await waitForBleMessage(bleSession);
            const receipt = verifyServerReceipt(receiptBytes, { txUuid, amount });
            setSendSettled({ amount: receipt.amount, currency: receipt.currency });
            setSendStep('settled');
            void refreshBalance();
            return;
          } catch (err) {
            // BLE relay failed partway through -- fall through to the QR
            // path below, same fail-open-to-QR discipline as the connect
            // attempt itself. Nothing above this point mutated server
            // state, so falling through is safe to retry via QR. Logged,
            // not swallowed silently -- see bleStatus's own doc comment.
            console.warn('[BLE] proposal/receipt exchange failed, falling back to QR:', err);
            setBleStatus('unavailable');
          } finally {
            // Close right away (success or failure) rather than leaving the
            // link open until the next resetFlow/role-switch -- see
            // resetNativeBleState's doc comment in bleTransport.ts for the
            // stale-disconnect race this was found to cause live.
            bleSession.close();
          }
        }
        setProposalQr(qr);
        setSendStep('proposal-shown');
        return;
      }

      // MODE_B: the PAYER is the one online here -- submit directly instead
      // of waiting for the (offline) payee to do it, then relay the receipt.
      const receiptBytes = await submitProposal(coseBytes);
      const receipt = verifyServerReceipt(receiptBytes, { txUuid, amount });
      setSendSettled({ amount: receipt.amount, currency: receipt.currency, relayQr: bytesToQrString(receiptBytes) });
      setSendStep('settled');
      void refreshBalance();
      // Best-effort direct relay over BLE too, alongside the QR shown above
      // -- same try-first-fall-back-to-QR discipline; the QR stays available
      // and correct regardless of whether this send succeeds. Closed right
      // after (see resetNativeBleState's doc comment in bleTransport.ts)
      // rather than left dangling until the next resetFlow.
      if (bleSendSessionRef.current) {
        const session = bleSendSessionRef.current;
        bleSendSessionRef.current = null;
        void session
          .send(receiptBytes)
          .catch(() => {})
          .finally(() => session.close());
      }
    } catch (err) {
      setError(String(err));
    }
  }, [identity, scannedRequest, derivedMode, amountInput, refreshBalance]);

  const handleReceiptScanned = useCallback(
    (qrData: string) => {
      setError(null);
      try {
        if (!signedProposal) throw new Error('no proposal was signed in this session -- start over');
        const bytes = qrStringToBytes(qrData);
        const classified = classifyPeerPayload(bytes, getServerPublicKeyBytes());

        if (classified.kind === 'receipt') {
          const receipt = verifyServerReceipt(bytes, { txUuid: signedProposal.txUuid, amount: signedProposal.amount });
          setSendSettled({ amount: receipt.amount, currency: receipt.currency });
          setSendStep('settled');
          void refreshBalance();
          return;
        }

        if (classified.kind === 'request') {
          // The payee's /tx/submit attempt failed and their screen reverted
          // to showing their (unchanged) Request QR -- give the real reason
          // instead of a confusing crypto-shaped error.
          throw new Error(
            "the payee couldn't complete the payment (their screen is showing a payment request, not a receipt) -- start over and try a different amount",
          );
        }

        throw new Error('unrecognized QR -- expected a receipt');
      } catch (err) {
        setError(String(err));
        setSendStep('awaiting-receipt');
      }
    },
    [signedProposal, refreshBalance],
  );

  const handleSignAndQueue = useCallback(async () => {
    if (!identity || !scannedRequest) return;
    setError(null);
    try {
      await signAndQueueIou(identity, bytesToUuid(scannedRequest.recipient_device_id), parseMinorUnits(amountInput));
      setSendStep('idle');
      setScannedRequest(null);
      setDerivedMode(null);
      setWarningAcked(false);
      setAmountInput('1.00');
      await refreshPending();
    } catch (err) {
      setError(String(err));
    }
  }, [identity, scannedRequest, amountInput, refreshPending]);

  const handleSync = useCallback(async () => {
    if (!identity) return;
    setSyncing(true);
    setError(null);
    try {
      await syncPendingIntents(identity);
      await refreshPending();
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncing(false);
    }
  }, [identity, refreshPending]);

  const [checkingId, setCheckingId] = useState<string | null>(null);
  const handleCheckIncoming = useCallback(
    async (intent: IncomingIntent) => {
      if (!identity) return;
      setError(null);
      setCheckingId(intent.txUuid);
      try {
        await pollIncomingReceipt(identity, intent);
        await refreshIncoming();
      } catch (err) {
        setError(String(err));
      } finally {
        setCheckingId(null);
      }
    },
    [identity, refreshIncoming],
  );

  const resetFlow = useCallback(() => {
    closeBleSessions();
    setReceiveStep('idle');
    setMyRequest(null);
    setRequestQr(null);
    setSettledReceipt(null);
    setRetryBytes(null);
    setSendStep('idle');
    setScannedRequest(null);
    setDerivedMode(null);
    setProposalQr(null);
    setSignedProposal(null);
    setSendSettled(null);
    setWarningAcked(false);
    setAmountInput('1.00');
    setError(null);
  }, [closeBleSessions]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>TapPay</Text>

      <IdentityHeader
        email={email}
        onEmailChange={setEmail}
        identity={identity}
        enrolling={enrolling}
        onEnroll={() => void handleEnroll()}
        online={online}
        balance={balance}
        onRefreshBalance={() => void refreshBalance()}
      />

      {error && (
        <View style={styles.section}>
          <Text style={styles.error}>{error}</Text>
          {retryBytes && role === 'receive' && receiveStep === 'awaiting-peer-payload' && (
            <TouchableOpacity style={styles.button} onPress={() => void handleRetrySubmission()}>
              <Text style={styles.buttonText}>Retry submission</Text>
            </TouchableOpacity>
          )}
          {/* Unconditional escape hatch from any step -- a failure on one
              side otherwise strands the other side waiting for something
              that's never coming, with no way back except force-quitting. */}
          <TouchableOpacity style={styles.button} onPress={resetFlow}>
            <Text style={styles.buttonText}>Start over</Text>
          </TouchableOpacity>
        </View>
      )}

      {identity && (
        <>
          <SegmentedRow
            label="I am"
            options={['receive', 'send'] as const}
            value={role}
            onChange={(next) => {
              setRole(next);
              resetFlow();
            }}
          />

          {role === 'receive' && (
            <View style={styles.section}>
              {receiveStep === 'idle' && (
                <TouchableOpacity style={styles.button} onPress={() => void handleStartRequest()}>
                  <Text style={styles.buttonText}>Request payment</Text>
                </TouchableOpacity>
              )}
              {receiveStep === 'showing-request' && requestQr && (
                <>
                  <QrWithCopyableText value={requestQr} />
                  {bleStatusLabel(bleStatus) && (
                    <Text style={[styles.readoutText, { color: bleStatusColor(bleStatus) }]}>{bleStatusLabel(bleStatus)}</Text>
                  )}
                  <TouchableOpacity style={styles.button} onPress={() => setReceiveStep('awaiting-peer-payload')}>
                    <Text style={styles.buttonText}>Scan their response</Text>
                  </TouchableOpacity>
                </>
              )}
              {receiveStep === 'awaiting-peer-payload' && (
                <ScanStep label="Scan the payer's proposal or receipt" onManualSubmit={(data) => void handlePeerPayloadScanned(data)} />
              )}
              {receiveStep === 'settled' && settledReceipt && (
                <>
                  <Text style={styles.settledText}>
                    SETTLED -- {formatMinorUnits(settledReceipt.amount)} {settledReceipt.currency}
                  </Text>
                  <Text style={styles.rowLabel}>Receipt (for the payer to verify, if they need it):</Text>
                  <QrWithCopyableText value={settledReceipt.qr} />
                  <TouchableOpacity style={styles.button} onPress={resetFlow}>
                    <Text style={styles.buttonText}>Start over</Text>
                  </TouchableOpacity>
                </>
              )}

              <Text style={styles.stepLabel}>Incoming (offline sends, unconfirmed until checked)</Text>
              {incoming.length === 0 && <Text style={styles.readoutText}>none</Text>}
              {incoming.map((intent) => (
                <View key={intent.txUuid} style={styles.row}>
                  <Text style={[styles.readoutText, { color: incomingStatusColor(intent.status) }]}>
                    {intent.status} -- {formatMinorUnits(BigInt(intent.amount))} {intent.currency} from {intent.senderDeviceId.slice(0, 8)}
                  </Text>
                  {intent.status === 'INCOMING' && (
                    <TouchableOpacity
                      style={[styles.smallButton, checkingId === intent.txUuid && styles.buttonDisabled]}
                      disabled={checkingId === intent.txUuid}
                      onPress={() => void handleCheckIncoming(intent)}
                    >
                      <Text style={styles.smallButtonText}>{checkingId === intent.txUuid ? 'Checking…' : 'Check status'}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </View>
          )}

          {role === 'send' && (
            <View style={styles.section}>
              {sendStep === 'idle' && (
                <TouchableOpacity style={styles.button} onPress={() => setSendStep('scan-request')}>
                  <Text style={styles.buttonText}>Scan a payment request</Text>
                </TouchableOpacity>
              )}
              {sendStep === 'scan-request' && (
                <ScanStep label="Scan the payee's Request QR" onManualSubmit={(data) => void handleRequestScanned(data)} />
              )}
              {sendStep === 'amount' && scannedRequest && (
                <View style={styles.section}>
                  <Text style={styles.stepLabel}>Recipient: {bytesToUuid(scannedRequest.recipient_device_id).slice(0, 8)}</Text>
                  <Text style={styles.readoutText}>
                    Mode: {derivedMode === ConnectivityMode.MODE_A ? 'A (they are online)' : derivedMode === ConnectivityMode.MODE_B ? 'B (you are online)' : 'C (both offline)'}
                  </Text>
                  {bleStatusLabel(bleStatus) && (
                    <Text style={[styles.readoutText, { color: bleStatusColor(bleStatus) }]}>{bleStatusLabel(bleStatus)}</Text>
                  )}
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Amount (MAD)</Text>
                    <TextInput style={styles.input} value={amountInput} onChangeText={setAmountInput} keyboardType="numeric" />
                  </View>
                  <TouchableOpacity style={styles.button} onPress={() => void handleContinue()}>
                    <Text style={styles.buttonText}>
                      {derivedMode === ConnectivityMode.MODE_C ? 'Continue' : 'Sign (biometric prompt)'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
              {sendStep === 'proposal-shown' && proposalQr && (
                <>
                  <QrWithCopyableText value={proposalQr} />
                  <TouchableOpacity style={styles.button} onPress={() => setSendStep('awaiting-receipt')}>
                    <Text style={styles.buttonText}>Payee submitted it -- scan their receipt</Text>
                  </TouchableOpacity>
                </>
              )}
              {sendStep === 'awaiting-receipt' && (
                <ScanStep label="Scan the payee's Receipt QR" onManualSubmit={handleReceiptScanned} />
              )}
              {sendStep === 'confirm-offline' && (
                <View style={styles.warningBox}>
                  <Text style={styles.warningTitle}>You are sending without the bank's confirmation</Text>
                  <Text style={styles.warningText}>
                    This is a signed promise, not a completed transfer. If it fails to sync later (insufficient funds,
                    expired token), you bear the loss until it settles. Nothing is final until this device reconnects
                    and syncs.
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
              {sendStep === 'settled' && sendSettled && (
                <>
                  <Text style={styles.settledText}>
                    SETTLED -- {formatMinorUnits(sendSettled.amount)} {sendSettled.currency}
                  </Text>
                  {sendSettled.relayQr && (
                    <>
                      <Text style={styles.rowLabel}>Relay this receipt to the offline payee:</Text>
                      <QrWithCopyableText value={sendSettled.relayQr} />
                    </>
                  )}
                  <TouchableOpacity style={styles.button} onPress={resetFlow}>
                    <Text style={styles.buttonText}>Start over</Text>
                  </TouchableOpacity>
                </>
              )}

              <Text style={styles.stepLabel}>Pending / recent local sends (offline)</Text>
              {pending.length === 0 && <Text style={styles.readoutText}>none</Text>}
              {pending.map((intent) => (
                <View key={intent.txUuid} style={styles.section}>
                  <View style={styles.row}>
                    <Text style={[styles.readoutText, { color: statusColor(intent.syncStatus) }]}>
                      {/* PENDING_INTENT is shown amber, full stop -- never green
                          until a sync response above actually says SETTLED. */}
                      {intent.syncStatus === 'PENDING' ? 'PENDING_INTENT' : intent.syncStatus} -- {formatMinorUnits(BigInt(intent.amount))} {intent.currency} to{' '}
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
                  {infoQrFor === intent.txUuid && identity && (
                    <>
                      <Text style={styles.readoutText}>
                        Unsigned, informational only -- lets the recipient locally track this incoming send. Never proof
                        of payment on its own.
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
  error: { color: '#ff6b6b' },
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
