import { randomBytes } from "node:crypto";
import { config } from "../config.js";

/**
 * In-memory (not persisted -- a restart invalidates any pending enrollment,
 * an accepted dev-scale tradeoff) tracker for issued-but-not-yet-consumed
 * enrollment nonces. Each nonce is the attestation challenge a device must
 * embed when generating its identity key (KeyStoreManager.generateIdentityKey,
 * M1 Step 6) -- consuming it here is what proves the attestation cert chain
 * was produced for THIS enrollment request, not replayed from an earlier one.
 */
const pending = new Map<string, number>(); // base64(nonce) -> expiresAt

/** Issues a fresh nonce, base64-encoded, tracked as pending until consumed or
 * expired. */
export function issueNonce(): string {
  const key = randomBytes(16).toString("base64");
  pending.set(key, Date.now() + config.enrollmentNonceTtlMs);
  return key;
}

/** True if `challenge` matches a still-pending, unexpired nonce this server
 * issued -- and consumes it either way (one-time use), so a replayed or
 * already-used challenge can never succeed twice. */
export function consumeNonce(challenge: Uint8Array): boolean {
  const key = Buffer.from(challenge).toString("base64");
  const expiresAt = pending.get(key);
  if (expiresAt === undefined) return false;
  pending.delete(key);
  return expiresAt >= Date.now();
}
