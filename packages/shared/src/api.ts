/**
 * Typed request/response DTOs for the v2 neobank routes
 * (docs/TapPay_v2_Technical_Design.md §5), imported by both server route
 * handlers and the mobile API client so the contract is checked at compile
 * time on both sides. Money is always a minor-units decimal string on the
 * wire (never a JSON number -- bigint doesn't survive JSON, and a number
 * would reintroduce float risk CLAUDE.md §5 forbids). Every authed shape
 * here matches exactly what server/src/routes/{auth,me,transfers,lookup,
 * beneficiaries}.ts actually sends -- kept in sync by hand, not generated.
 */

export type ErrorCode =
  | "InvalidRequest"
  | "InvalidCredentials"
  | "InvalidRefreshToken"
  | "IncompleteProfile"
  | "InvalidAmount"
  | "InvalidCurrency"
  | "InvalidRib"
  | "UnknownBeneficiary"
  | "UnknownRecipient"
  | "SelfPayment"
  | "TxUuidConflict"
  | "ReservationExpired"
  | "InsufficientFunds"
  | "DuplicateBeneficiary"
  | "NotFound";

export interface ApiErrorBody {
  error: ErrorCode;
  message: string;
}

// ---- POST /auth/login ----

export interface LoginRequest {
  customer_id: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  user: { customer_id: string; account_id: string };
}

// ---- POST /auth/refresh ----

export interface RefreshRequest {
  refresh_token: string;
}

export interface RefreshResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

// ---- POST /auth/logout ----

export interface LogoutRequest {
  refresh_token: string;
}
// 204 No Content on success -- no response body.

// ---- GET /me ----

export interface MeResponse {
  customer_id: string;
  display_name: string;
  account_id: string;
  rib: string;
  iban: string;
  currency: string;
}

// ---- GET /accounts/me/balance ----

export interface BalanceResponse {
  account_id: string;
  currency: string;
  /** Minor-units decimal string, e.g. "125000" for 1,250.00 MAD. */
  available_balance: string;
}

// ---- GET /accounts/me/transactions ----

export type TransactionDirection = "debit" | "credit";

export interface TransactionSummary {
  tx_uuid: string;
  direction: TransactionDirection;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_rib: string | null;
  reference: string | null;
  created_at: string;
}

export interface TransactionsResponse {
  transactions: TransactionSummary[];
  next_cursor: string | null;
}

export interface TransactionsQuery {
  limit?: number;
  before?: string;
}

// ---- POST /transfers ----

export interface CreateTransferRequest {
  tx_uuid: string;
  to_rib?: string;
  to_beneficiary_id?: string;
  /** Minor-units decimal string. */
  amount: string;
  currency: string;
  reference: string;
}

export interface CreateTransferResponse {
  tx_uuid: string;
  settled_at: string;
  amount: string;
  currency: string;
  reference: string;
  counterparty: { display_name: string | null; rib: string | null } | null;
  balance_after: string;
}

// ---- GET /transfers/:txUuid ----

export interface TransferDetailResponse {
  tx_uuid: string;
  direction: TransactionDirection;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_rib: string | null;
  reference: string | null;
  created_at: string;
}

// ---- GET /lookup/rib/:rib ----

export interface RibLookupResponse {
  rib: string;
  display_name: string;
}

// ---- /beneficiaries ----

export interface Beneficiary {
  id: string;
  display_name: string;
  rib: string;
}

export interface BeneficiariesResponse {
  beneficiaries: Beneficiary[];
}

export interface CreateBeneficiaryRequest {
  display_name: string;
  rib: string;
}

export type CreateBeneficiaryResponse = Beneficiary;

export interface UpdateBeneficiaryRequest {
  display_name: string;
}

export type UpdateBeneficiaryResponse = Beneficiary;
