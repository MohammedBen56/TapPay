import { db } from "../db/kysely.js";

export interface AuditEvent {
  /** null when the actor can't be resolved -- e.g. a failed login against
   * an unknown customer_id. Still worth recording: that's exactly the
   * kind of event a security-relevant audit log should capture. */
  userId: string | null;
  /** Dot-namespaced, e.g. "login.success", "login.failure", "logout",
   * "beneficiary.create", "beneficiary.delete", "transfer.settle",
   * "bill_payment.settle". Free text, not an enum -- new call sites
   * shouldn't need a migration to add an action name. */
  action: string;
  resourceType?: string;
  resourceId?: string;
  ip?: string;
}

let auditLogger: { error: (obj: unknown, msg?: string) => void } | undefined;
export function setAuditLogger(logger: { error: (obj: unknown, msg?: string) => void }): void {
  auditLogger = logger;
}

/** Best-effort, deliberately: the real action being audited (a login, a
 * settlement) must never fail just because this secondary write did --
 * same reasoning already established in this codebase for
 * bill_payments' own best-effort insert after a successful settlement
 * (billPayments.ts). Failures are logged, never swallowed silently
 * (CLAUDE.md §8), just never allowed to propagate into the caller's
 * response. */
export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    await db
      .insertInto("audit_log")
      .values({
        user_id: event.userId,
        action: event.action,
        resource_type: event.resourceType ?? null,
        resource_id: event.resourceId ?? null,
        ip: event.ip ?? null,
      })
      .execute();
  } catch (err) {
    (auditLogger ?? console).error(err, `audit log write failed for action "${event.action}"`);
  }
}
