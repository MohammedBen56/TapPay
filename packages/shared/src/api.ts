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
  | "UnknownBiller"
  | "SelfPayment"
  | "TxUuidConflict"
  | "ReservationExpired"
  | "InsufficientFunds"
  | "DuplicateBeneficiary"
  | "DuplicateAccount"
  | "DuplicateDispute"
  | "NotFound"
  // Ship List v2 Wave 2 Phase 4:
  | "StepUpRequired"
  | "VelocityCapExceeded"
  | "AccountBusy";

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

// ---- POST /auth/change-password ----

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}
// 204 No Content on success -- no response body. Revokes every active
// session for the user (server/src/auth/refreshTokens.ts's
// revokeAllSessionsForUser) -- the caller itself gets signed out too.

// ---- POST /auth/step-up (Ship List v2 Wave 2 Phase 4) ----

export interface StepUpRequest {
  password: string;
  /** The tx_uuid of the transfer this step-up is for -- the minted token
   * is bound to it and rejected by POST /transfers for any other tx_uuid. */
  tx_uuid: string;
}

export interface StepUpResponse {
  step_up_token: string;
  expires_in: number;
}

// ---- /auth/sessions ----

export interface SessionSummary {
  id: string;
  issued_at: string;
  expires_at: string;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}
// DELETE /auth/sessions/:id -- 204 No Content on success, no response body.

export type AccountType = "checking" | "savings";

// ---- GET /accounts ----

export interface AccountSummary {
  account_id: string;
  account_type: AccountType;
  rib: string | null;
  currency: string;
  /** Minor-units decimal string. */
  available_balance: string;
}

export interface AccountsResponse {
  accounts: AccountSummary[];
}

// ---- POST /accounts ----

export interface OpenAccountRequest {
  /** The only client-choosable type -- `checking` always exists already. */
  account_type: "savings";
}

export type OpenAccountResponse = AccountSummary;

// ---- GET /me ----

export interface MeQuery {
  /** Ship List v2 Phase 8 -- omit for the caller's checking account. */
  account_id?: string;
}

export interface MeResponse {
  customer_id: string;
  display_name: string;
  account_id: string;
  account_type: AccountType;
  rib: string;
  iban: string;
  currency: string;
  /** Ship List v2 Wave 2 Phase 5 -- a per-identity preference, not
   * per-account (unaffected by which account_id was queried). */
  round_up_enabled: boolean;
}

// ---- PATCH /me (Ship List v2 Wave 2 Phase 5) ----

export interface UpdateMeRequest {
  round_up_enabled: boolean;
}
// Response: MeResponse (the account_id/account_type/rib/etc. fields are
// resolved the same way GET /me's are -- the caller's checking account,
// since PATCH /me takes no ?account_id=).

// ---- GET /accounts/me/balance ----

export interface BalanceQuery {
  account_id?: string;
}

export interface BalanceResponse {
  account_id: string;
  account_type: AccountType;
  currency: string;
  /** Minor-units decimal string, e.g. "125000" for 1,250.00 MAD. */
  available_balance: string;
}

// ---- GET /me/data-export ----

export interface DataExportTransaction {
  tx_uuid: string;
  direction: "debit" | "credit";
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_rib: string | null;
  reference: string | null;
  created_at: string;
}

export interface DataExportBillPayment {
  tx_uuid: string;
  biller_name: string;
  subscriber_reference: string;
  amount: string;
  currency: string;
  created_at: string;
}

export interface DataExportBeneficiary {
  display_name: string;
  rib: string;
  created_at: string;
}

export interface DataExportResponse {
  exported_at: string;
  profile: {
    customer_id: string;
    display_name: string;
    account_id: string;
    account_type: AccountType;
    rib: string;
    currency: string;
    account_created_at: string;
  };
  transactions: DataExportTransaction[];
  bill_payments: DataExportBillPayment[];
  beneficiaries: DataExportBeneficiary[];
}

// ---- GET /accounts/me/statement ----

export interface StatementQuery {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, inclusive (through end of day). */
  to: string;
  /** Ship List v2 Phase 8 -- omit for the caller's checking account. */
  account_id?: string;
}

export interface StatementTransaction {
  tx_uuid: string;
  direction: "debit" | "credit";
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_rib: string | null;
  reference: string | null;
  created_at: string;
}

export interface StatementResponse {
  customer_id: string;
  display_name: string;
  rib: string;
  currency: string;
  from: string;
  to: string;
  /** Minor-units decimal string; may be negative. */
  opening_balance: string;
  /** Minor-units decimal string; may be negative. */
  closing_balance: string;
  transactions: StatementTransaction[];
}

// ---- GET /accounts/me/transactions ----

export type TransactionDirection = "debit" | "credit";

export type BillerCategory = "electricity" | "water" | "internet";

export interface TransactionSummary {
  tx_uuid: string;
  direction: TransactionDirection;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_rib: string | null;
  reference: string | null;
  created_at: string;
  /** True when the counterparty is a biller (bill payment), not a person. */
  is_biller: boolean;
  biller_category: BillerCategory | null;
}

export interface TransactionsResponse {
  transactions: TransactionSummary[];
  next_cursor: string | null;
}

export interface TransactionsQuery {
  limit?: number;
  before?: string;
  /** Ship List v2 Phase 8 -- omit for the caller's checking account. */
  account_id?: string;
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
  /** Ship List v2 Phase 8 -- which of the caller's own accounts sends the
   * money. Omit for the caller's checking account. */
  from_account_id?: string;
  /** Ship List v2 Wave 2 Phase 4 -- required once amount reaches the
   * server's stepUpThresholdMinorUnits; obtained via POST /auth/step-up,
   * bound to this SAME tx_uuid. */
  step_up_token?: string;
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
  is_biller: boolean;
  biller_category: BillerCategory | null;
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

// ---- GET /billers ----

export interface Biller {
  id: string;
  name: string;
  category: BillerCategory;
}

export interface BillersResponse {
  billers: Biller[];
}

// ---- POST /bill-payments ----

export interface PayBillRequest {
  tx_uuid: string;
  biller_id: string;
  subscriber_reference: string;
  /** Minor-units decimal string. */
  amount: string;
  currency: string;
}

export interface PayBillResponse {
  tx_uuid: string;
  settled_at: string;
  biller: Biller;
  subscriber_reference: string;
  amount: string;
  currency: string;
  reference: string;
  balance_after: string;
}

// ---- GET /bill-payments ----

export interface BillPaymentSummary {
  tx_uuid: string;
  biller: Biller;
  subscriber_reference: string;
  amount: string;
  currency: string;
  reference: string;
  created_at: string;
}

export interface BillPaymentsResponse {
  bill_payments: BillPaymentSummary[];
  next_cursor: string | null;
}

export interface BillPaymentsQuery {
  limit?: number;
  before?: string;
}

// ---- GET /bill-payments/:txUuid ----

export type BillPaymentDetailResponse = BillPaymentSummary;

// ---- Financial goals/vaults (Ship List v2 Wave 2 Phase 5) ----
// A goal earmarks an amount inside the customer's ONE real savings
// account -- it is not a separate ledger account, so funding a goal is a
// pure bookkeeping increment, never a transfer (server/migrations/
// 026_goals.cjs's own comment has the full reasoning).

export interface Goal {
  id: string;
  name: string;
  /** Minor-units decimal string. */
  target_amount: string;
  /** Minor-units decimal string. */
  saved_amount: string;
  target_date: string | null;
  created_at: string;
}

export interface GoalsResponse {
  goals: Goal[];
}

export interface CreateGoalRequest {
  name: string;
  target_amount: string;
  target_date?: string;
}

export interface FundGoalRequest {
  amount: string;
}

// ---- GET /subscriptions (Ship List v2 Wave 2 Phase 5) ----
// Pure read-only pattern detection over existing transfer history -- no
// write path, no new stored data. See server/src/routes/subscriptions.ts.

export interface DetectedSubscription {
  counterparty_account_id: string;
  counterparty_name: string | null;
  /** Minor-units decimal string. */
  amount: string;
  currency: string;
  occurrences: number;
  last_paid_at: string;
  average_interval_days: number;
}

export interface SubscriptionsResponse {
  subscriptions: DetectedSubscription[];
}

// ---- Support requests + disputes (Ship List v2 Wave 2 Phase 6) ----
// Both a real, stored request -- no admin reply flow yet (single-owner
// review), see server/src/routes/{support,disputes}.ts.

export type SupportRequestStatus = "open" | "resolved";

export interface SupportRequest {
  id: string;
  subject: string;
  message: string;
  status: SupportRequestStatus;
  created_at: string;
}

export interface SupportRequestsResponse {
  support_requests: SupportRequest[];
}

export interface CreateSupportRequestRequest {
  subject: string;
  message: string;
}

export type DisputeStatus = "open" | "resolved";

export interface Dispute {
  id: string;
  tx_uuid: string;
  reason: string;
  status: DisputeStatus;
  created_at: string;
}

export interface DisputesResponse {
  disputes: Dispute[];
}

export interface CreateDisputeRequest {
  tx_uuid: string;
  reason: string;
}
