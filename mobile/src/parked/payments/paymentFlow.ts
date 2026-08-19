import {
  bytesEqual,
  decodeCoseSign1Unverified,
  decodeFreshnessToken,
  decodeTxReceipt,
  encodeOfflineIou,
  encodeTxProposal,
  encodeTxRequest,
  signCoseSign1,
  uuidToBytes,
  verifyCoseSign1,
  type OfflineIou,
  type TxProposal,
  type TxReceipt,
  type TxRequest,
} from '@tappay/shared';
import * as Crypto from 'expo-crypto';

import { getServerPublicKeyBytes } from '../config/serverPublicKey';
import { SERVER_BASE_URL } from '../../config/serverUrl';
import { createIdentitySigner, fetchFreshnessToken, type EnrolledIdentity } from '../crypto/identity';
import {
  cacheFreshnessToken,
  getCachedFreshnessToken,
  getNextSeq,
  insertPendingIntent,
  listPendingIntents,
  markIncomingSettled,
  markSyncResult,
  type IncomingIntent,
  type PendingIntent,
} from '../db/offlineIntents';
import { probeServerReachable } from '../net/connectivity';
import { bytesToQrString } from '../transport/qr';
import { base64ToBytes, bytesToBase64 } from '../../util/base64';
import { uuidv4 } from '../../util/uuid';

/**
 * Pure orchestration for the unified payment flow (PayScreen.tsx, Phase 5) --
 * no JSX, so this module is testable in principle even though mobile has no
 * test runner today (`pnpm --filter @tappay/mobile lint` is `tsc --noEmit`
 * only). Extracted from TapScreen.tsx (Mode A) and OfflineScreen.tsx (Mode
 * B/C), which this replaces: every function here is the same logic those two
 * screens had, deduplicated across the 3 modes rather than triplicated.
 */

// Must match server config.offlineFreshnessTokenTtlMs.
const FRESHNESS_TOKEN_TTL_MS = 24 * 60 * 60_000;

// --- Receive side: generating a request, submitting a scanned proposal -----

/** The payee's Request QR -- carries a fresh nonce and this device's own
 * connectivity self-assessment (receiver_online), the hint PayScreen's mode
 * selection combines with the payer's own probeServerReachable() result. */
export async function generatePaymentRequest(identity: EnrolledIdentity): Promise<{ request: TxRequest; qr: string }> {
  const receiverNonce = Crypto.getRandomBytes(16);
  const receiverOnline = await probeServerReachable();
  const request: TxRequest = {
    recipient_device_id: uuidToBytes(identity.deviceId),
    receiver_nonce: receiverNonce,
    ts: Date.now(),
    receiver_online: receiverOnline,
  };
  return { request, qr: bytesToQrString(encodeTxRequest(request)) };
}

/** POSTs a signed proposal's raw COSE bytes to /tx/submit and returns the
 * raw receipt bytes -- the same call whether the CALLER is the payee (Mode
 * A: relaying a scanned peer proposal, never decoded client-side, per
 * classifyPeerPayload's doc comment on why proposal signatures aren't
 * verified on-device) or the payer (Mode B: submitting their own
 * just-signed proposal directly, no scan round trip needed for this step). */
export async function submitProposal(coseBytes: Uint8Array): Promise<Uint8Array> {
  const res = await fetch(`${SERVER_BASE_URL}/tx/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cose_sign1: bytesToBase64(coseBytes) }),
  });
  const body = (await res.json()) as { receipt?: string; message?: string; error?: string };
  if (!res.ok || !body.receipt) {
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return base64ToBytes(body.receipt);
}

// --- Send side: signing a proposal against a scanned request ---------------

export async function buildSignedProposal(
  identity: EnrolledIdentity,
  request: TxRequest,
  amount: bigint,
): Promise<{ txUuid: Uint8Array; coseBytes: Uint8Array; qr: string }> {
  const txUuid = uuidToBytes(uuidv4());
  const proposal: TxProposal = {
    tx_uuid: txUuid,
    sender_device_id: uuidToBytes(identity.deviceId),
    recipient_device_id: request.recipient_device_id,
    amount,
    currency: 'MAD',
    receiver_nonce: request.receiver_nonce,
    ts: Date.now(),
  };
  // Biometric prompt happens here (KeyStoreManager.sign).
  const coseBytes = await signCoseSign1(encodeTxProposal(proposal), createIdentitySigner(identity.deviceId));
  return { txUuid, coseBytes, qr: bytesToQrString(coseBytes) };
}

// --- Receipt verification: the check every mode's payer/payee needs --------

/** What a scanned/fetched receipt must be bound to before it can be trusted
 * -- a valid server signature ALONE is not enough (TxReceipt is otherwise a
 * bearer token: any previously-settled receipt of the right shape would pass
 * signature verification without these checks; found via /security-review,
 * see TxReceipt's doc comment in packages/shared). Every field supplied here
 * is checked; omit a field only when this call site genuinely has nothing to
 * bind it against.
 *
 * Consolidates the three call sites that used to hand-roll this check
 * separately (TapScreen.tsx's payer, OfflineScreen.tsx's Mode B payee, Mode C
 * payee) into one implementation. */
export interface ReceiptBinding {
  txUuid?: Uint8Array;
  amount?: bigint;
  recipientDeviceId?: Uint8Array;
  receiverNonce?: Uint8Array;
}

export function verifyServerReceipt(receiptBytes: Uint8Array, binding: ReceiptBinding): TxReceipt {
  const verified = verifyCoseSign1(receiptBytes, getServerPublicKeyBytes());
  if (!verified) {
    throw new Error('receipt signature does not verify against the pinned server key');
  }
  const receipt = decodeTxReceipt(verified.payload);
  if (binding.txUuid && !bytesEqual(receipt.tx_uuid, binding.txUuid)) {
    throw new Error('this receipt is for a different transaction than expected -- possible relay of an unrelated receipt');
  }
  if (binding.amount !== undefined && receipt.amount !== binding.amount) {
    throw new Error('this receipt is for a different amount than expected -- possible relay of an unrelated receipt');
  }
  if (binding.recipientDeviceId && !bytesEqual(receipt.recipient_device_id, binding.recipientDeviceId)) {
    throw new Error('this receipt does not name this device as the recipient -- possible relay of an unrelated receipt');
  }
  if (binding.receiverNonce && !bytesEqual(receipt.receiver_nonce, binding.receiverNonce)) {
    throw new Error('this receipt does not carry the nonce this device generated for this request -- possible relay of an unrelated receipt');
  }
  return receipt;
}

// --- Mode C: offline IOU, sign + local queue, and reconnect sync -----------

/** Signs and locally queues a Mode C IOU (never touches the network itself --
 * that's the whole point of Mode C). Refreshes the cached freshness token
 * proactively at the halfway point of its TTL (not just when already
 * expired) so a token handed to the caller is never about to lapse mid-
 * offline-period; that refresh does require connectivity right now. */
export async function signAndQueueIou(identity: EnrolledIdentity, recipientDeviceId: string, amount: bigint): Promise<void> {
  let cached = await getCachedFreshnessToken(identity.deviceId);
  if (!cached || Date.now() - cached.issuedAt > FRESHNESS_TOKEN_TTL_MS / 2) {
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
    amount,
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
}

/** Reconnect & Sync: POSTs every locally-PENDING intent to /tx/sync and
 * records each result. A no-op (not an error) when nothing is pending. */
export async function syncPendingIntents(identity: EnrolledIdentity): Promise<void> {
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
  if (!res.ok || !body.results) {
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  for (const result of body.results) {
    if (result.tx_uuid) {
      await markSyncResult(result.tx_uuid, result.status, result.receipt);
    }
  }
}

/** A Mode C payee's "Check status" action: the ONLY independently-verifiable
 * proof of settlement this device has (CLAUDE.md §5 -- a payee's phone can
 * never verify a peer's identity-key signature, only the server can). Returns
 * false (not an error) for "not settled yet" (404); throws on a genuine
 * failure (bad signature, wrong binding, network error). */
export async function pollIncomingReceipt(identity: EnrolledIdentity, intent: IncomingIntent): Promise<boolean> {
  const res = await fetch(`${SERVER_BASE_URL}/tx/${intent.txUuid}/receipt`);
  if (res.status === 404) return false;
  const body = (await res.json()) as { receipt?: string; message?: string };
  if (!res.ok || !body.receipt) {
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }

  // The txUuid path param is this device's own local (client-chosen) record --
  // a valid signature alone only proves the server signed SOME receipt for
  // that tx_uuid, not that it's for THIS payee and THIS amount. Bind it to
  // what the (unsigned, payer-claimed) info QR said.
  verifyServerReceipt(base64ToBytes(body.receipt), {
    recipientDeviceId: uuidToBytes(identity.deviceId),
    amount: BigInt(intent.amount),
  });

  await markIncomingSettled(intent.txUuid, body.receipt);
  return true;
}

// --- Balance readout ---------------------------------------------------

/** GET /accounts/:accountId/balance -- first mobile caller of this route
 * (Phase 5). Returns the available balance in bigint minor units, ready for
 * @tappay/shared's formatMinorUnits. */
export async function fetchBalance(accountId: string): Promise<bigint> {
  const res = await fetch(`${SERVER_BASE_URL}/accounts/${accountId}/balance`);
  if (!res.ok) {
    throw new Error(`failed to fetch balance: ${res.status}`);
  }
  const body = (await res.json()) as { available_balance: string };
  return BigInt(body.available_balance);
}
