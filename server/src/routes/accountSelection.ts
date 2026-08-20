import type { AccountType } from "../db/kysely.js";
import { db } from "../db/kysely.js";

/**
 * Ship List v2 Phase 8: every account-scoped route needs to resolve WHICH
 * of a customer's own accounts (checking, or savings once opened) a
 * request is about. Centralized here so every call site applies the same
 * ownership check the same way -- CLAUDE.md §5's binding rule ("resolves
 * the account from the JWT's aid/sub claims, never a client-supplied id")
 * still holds; a client-supplied `account_id` is now permitted, but ONLY
 * after being checked against the caller's own `user_id` from the JWT,
 * exactly the same shape as `beneficiaries`' `owner_user_id` scoping this
 * codebase already established. A miss (wrong owner OR nonexistent)
 * resolves to `null` either way -- callers turn that into the same typed
 * 404, so this never distinguishes "not yours" from "doesn't exist"
 * (no existence-leak, matching the RIB-lookup/beneficiary pattern).
 */
export interface OwnedAccount {
  account_id: string;
  account_type: AccountType;
  rib: string | null;
  currency: string;
  display_name: string | null;
  created_at: Date;
}

/** `requestedAccountId` absent -> defaults to the caller's `checking`
 * account, preserving every pre-Phase-8 call site's behavior unchanged. */
export async function resolveOwnedAccount(userId: string, requestedAccountId?: string): Promise<OwnedAccount | null> {
  let query = db
    .selectFrom("accounts")
    .innerJoin("users", "users.user_id", "accounts.user_id")
    .select([
      "accounts.account_id as account_id",
      "accounts.account_type as account_type",
      "accounts.rib as rib",
      "accounts.currency as currency",
      "users.display_name as display_name",
      "accounts.created_at as created_at",
    ])
    .where("accounts.user_id", "=", userId);

  query = requestedAccountId
    ? query.where("accounts.account_id", "=", requestedAccountId)
    : query.where("accounts.account_type", "=", "checking");

  const row = await query.executeTakeFirst();
  return row ?? null;
}

/** Ship List v2 Wave 2 Phase 5: resolves the caller's account of a SPECIFIC
 * type (e.g. "does this user have a savings account, and if so what's its
 * id") -- distinct from resolveOwnedAccount's "which of my accounts does
 * this request mean" (client-supplied id or default-to-checking). Used by
 * roundup.ts, which needs the savings account regardless of what account
 * the triggering transfer itself used. Returns null if the user has no
 * account of that type yet (e.g. never opened savings). */
export async function resolveAccountByType(userId: string, accountType: AccountType): Promise<OwnedAccount | null> {
  const row = await db
    .selectFrom("accounts")
    .innerJoin("users", "users.user_id", "accounts.user_id")
    .select([
      "accounts.account_id as account_id",
      "accounts.account_type as account_type",
      "accounts.rib as rib",
      "accounts.currency as currency",
      "users.display_name as display_name",
      "accounts.created_at as created_at",
    ])
    .where("accounts.user_id", "=", userId)
    .where("accounts.account_type", "=", accountType)
    .executeTakeFirst();
  return row ?? null;
}
