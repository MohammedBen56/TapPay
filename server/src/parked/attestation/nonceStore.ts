import { randomBytes } from "node:crypto";
import { config } from "../../config.js";

/**
 * In-memory (not persisted -- a restart invalidates any pending enrollment,
 * an accepted dev-scale tradeoff) tracker for issued-but-not-yet-consumed
 * enrollment nonces. Each nonce is the attestation challenge a device must
 * embed when generating its identity key (KeyStoreManager.generateIdentityKey,
 * M1 Step 6) -- consuming it here is what proves the attestation cert chain
 * was produced for THIS enrollment request, not replayed from an earlier one.
 */
const pending = new Map<string, number>(); // base64(nonce) -> expiresAt

/** Drops every entry past its TTL. Previously nonces were only ever removed
 * on consumption -- an attacker who never calls /devices/enroll (or calls it
 * with a bogus challenge) left every issued nonce sitting in memory forever,
 * an unauthenticated, unbounded growth vector on an endpoint that requires no
 * auth at all. Called on every issuance rather than on a timer, so it costs
 * nothing when the store is quiet and self-corrects under load. */
function reapExpired(): void {
  const now = Date.now();
  for (const [key, expiresAt] of pending) {
    if (expiresAt < now) pending.delete(key);
  }
}

/** Issues a fresh nonce, base64-encoded, tracked as pending until consumed or
 * expired. Throws if the store is at its hard cap even after reaping --
 * config.enrollmentNonceMaxPending is generous enough that legitimate
 * enrollment traffic should never hit it; a flood that does is exactly the
 * scenario the cap exists for. */
export function issueNonce(): string {
  reapExpired();
  if (pending.size >= config.enrollmentNonceMaxPending) {
    throw Object.assign(new Error("too many pending enrollment nonces"), { statusCode: 503 });
  }
  const key = randomBytes(16).toString("base64");
  pending.set(key, Date.now() + config.enrollmentNonceTtlMs);
  return key;
}

/** Test-only visibility into the store's current size. */
export function pendingNonceCount(): number {
  return pending.size;
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
