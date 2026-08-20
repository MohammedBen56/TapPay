import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db/kysely.js";

export interface IssuedRefreshToken {
  /** Raw token -- returned to the client exactly once, never stored. */
  token: string;
  sessionId: string;
  familyId: string;
  expiresAt: Date;
}

/** Opaque, not a parseable JWT (docs/TapPay_v2_Technical_Design.md §6): a DB
 * leak of auth_sessions never yields a usable token, since only the hash is
 * stored. */
function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export async function issueRefreshToken(userId: string, familyId: string = randomUUID()): Promise<IssuedRefreshToken> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlSeconds * 1000);
  const row = await db
    .insertInto("auth_sessions")
    .values({ user_id: userId, token_hash: hashToken(token), family_id: familyId, expires_at: expiresAt })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { token, sessionId: row.id, familyId, expiresAt };
}

export type RefreshResult =
  | { outcome: "ok"; userId: string; issued: IssuedRefreshToken }
  | { outcome: "invalid" }
  /** The presented token was already rotated away (a NEWER token exists) --
   * a legitimate client never re-presents a superseded token, so this is the
   * theft-detection signal from docs/TapPay_v2_Technical_Design.md §6. The
   * whole family gets revoked as a side effect before this is returned. */
  | { outcome: "reused_after_rotation" };

/** Validates + rotates a refresh token in one step: the old row is marked
 * revoked (with replaced_by pointing at the new one) and a fresh token is
 * issued in the same family, so a rotation chain can always be traced and
 * revoked as a unit. Fails closed (outcome "invalid") on any of: not found,
 * expired, or revoked-with-no-replacement (e.g. already logged out). */
export async function rotateRefreshToken(presentedToken: string): Promise<RefreshResult> {
  const tokenHash = hashToken(presentedToken);
  const row = await db.selectFrom("auth_sessions").selectAll().where("token_hash", "=", tokenHash).executeTakeFirst();
  if (!row) return { outcome: "invalid" };
  if (row.expires_at.getTime() < Date.now()) return { outcome: "invalid" };

  if (row.revoked_at) {
    if (row.replaced_by) {
      await revokeFamily(row.family_id);
      return { outcome: "reused_after_rotation" };
    }
    // Revoked with no replacement -- e.g. a prior logout. Not a theft
    // signal, just no longer valid.
    return { outcome: "invalid" };
  }

  const issued = await issueRefreshToken(row.user_id, row.family_id);
  await db
    .updateTable("auth_sessions")
    .set({ revoked_at: new Date(), replaced_by: issued.sessionId })
    .where("id", "=", row.id)
    .execute();

  return { outcome: "ok", userId: row.user_id, issued };
}

/** Idempotent: revoking an already-revoked or nonexistent token is a no-op,
 * matching /auth/logout's "204 regardless of prior state" contract. */
export async function revokeRefreshToken(presentedToken: string): Promise<void> {
  const tokenHash = hashToken(presentedToken);
  await db
    .updateTable("auth_sessions")
    .set({ revoked_at: new Date() })
    .where("token_hash", "=", tokenHash)
    .where("revoked_at", "is", null)
    .execute();
}

/** Revokes every not-yet-revoked row in a rotation family in one shot --
 * the same logic rotateRefreshToken's theft-detection branch already used
 * inline, now shared with routes/auth.ts's explicit "log out this
 * session/device" (Ship List v2) and revokeAllSessionsForUser below.
 * Idempotent: a family with nothing left to revoke is a harmless no-op. */
export async function revokeFamily(familyId: string): Promise<void> {
  await db
    .updateTable("auth_sessions")
    .set({ revoked_at: new Date() })
    .where("family_id", "=", familyId)
    .where("revoked_at", "is", null)
    .execute();
}

/** Every active session (one row per family, since a family's older,
 * already-rotated-away rows already carry their own revoked_at) for a
 * user, oldest first. Ship List v2's session/device management --
 * GET /auth/sessions lists these; DELETE /auth/sessions/:id revokes one
 * family via revokeFamily above after an ownership check in the route. */
export interface ActiveSession {
  id: string;
  familyId: string;
  issuedAt: Date;
  expiresAt: Date;
}

export async function listActiveSessions(userId: string): Promise<ActiveSession[]> {
  const rows = await db
    .selectFrom("auth_sessions")
    .select(["id", "family_id", "issued_at", "expires_at"])
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", new Date())
    .orderBy("issued_at", "asc")
    .execute();
  return rows.map((r) => ({ id: r.id, familyId: r.family_id, issuedAt: r.issued_at, expiresAt: r.expires_at }));
}

/** Used by change-password (Ship List v2): rotating a credential is the
 * one case where every active session -- not just one family -- should be
 * invalidated, on the assumption that a password change may be in
 * response to a suspected compromise. Simpler and safer than trying to
 * spare "the session that just made this request": the access token
 * carries no session/family id to spare correctly, and guessing wrong
 * would leave a potentially-compromised session alive. */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await db
    .updateTable("auth_sessions")
    .set({ revoked_at: new Date() })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .execute();
}
