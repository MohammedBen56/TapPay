import type {
  AccountsResponse,
  BalanceQuery,
  BalanceResponse,
  BeneficiariesResponse,
  BillersResponse,
  BillPaymentDetailResponse,
  BillPaymentsQuery,
  BillPaymentsResponse,
  ChangePasswordRequest,
  CreateBeneficiaryRequest,
  CreateBeneficiaryResponse,
  CreateDisputeRequest,
  CreateGoalRequest,
  CreateMoneyRequestRequest,
  CreateMoneyRequestResponse,
  CreateSupportRequestRequest,
  CreateTransferRequest,
  CreateTransferResponse,
  DataExportResponse,
  Dispute,
  DisputesResponse,
  FulfillMoneyRequestResponse,
  FundGoalRequest,
  Goal,
  GoalsResponse,
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  MeQuery,
  MeResponse,
  MoneyRequestsResponse,
  NotificationsResponse,
  OpenAccountRequest,
  OpenAccountResponse,
  PayBillRequest,
  PayBillResponse,
  RefreshRequest,
  RefreshResponse,
  RegisterPushTokenRequest,
  RibLookupResponse,
  SessionsResponse,
  StatementQuery,
  StatementResponse,
  StepUpRequest,
  StepUpResponse,
  SubscriptionsResponse,
  SupportRequest,
  SupportRequestsResponse,
  TransactionsQuery,
  TransactionsResponse,
  TransferDetailResponse,
  UpdateBeneficiaryRequest,
  UpdateBeneficiaryResponse,
  UpdateMeRequest,
} from "@tappay/shared";
import { getDeviceId } from "../auth/deviceId";
import { apiRequest } from "./client";

function query(params: TransactionsQuery = {}): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.before !== undefined) search.set("before", params.before);
  if (params.account_id !== undefined) search.set("account_id", params.account_id);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

function accountQuery(params: MeQuery | BalanceQuery = {}): string {
  return params.account_id !== undefined ? `?account_id=${encodeURIComponent(params.account_id)}` : "";
}

function billPaymentsQuery(params: BillPaymentsQuery = {}): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.before !== undefined) search.set("before", params.before);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  // Ship List v2 Wave 2 Phase 4: X-Device-Id backs the server's
  // login-anomaly signal (server/src/auth/deviceFingerprint.ts) -- login
  // is the one call site that attaches it, since that's the only route
  // that reads it.
  login: async (body: LoginRequest) =>
    apiRequest<LoginResponse>("/auth/login", {
      method: "POST",
      body,
      auth: false,
      extraHeaders: { "x-device-id": await getDeviceId() },
    }),
  refresh: (body: RefreshRequest) => apiRequest<RefreshResponse>("/auth/refresh", { method: "POST", body, auth: false }),
  logout: (body: LogoutRequest) => apiRequest<void>("/auth/logout", { method: "POST", body }),
  changePassword: (body: ChangePasswordRequest) => apiRequest<void>("/auth/change-password", { method: "POST", body }),
  stepUp: (body: StepUpRequest) => apiRequest<StepUpResponse>("/auth/step-up", { method: "POST", body }),
  sessions: () => apiRequest<SessionsResponse>("/auth/sessions"),
  revokeSession: (id: string) => apiRequest<void>(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),

  accounts: () => apiRequest<AccountsResponse>("/accounts"),
  openAccount: (body: OpenAccountRequest) => apiRequest<OpenAccountResponse>("/accounts", { method: "POST", body }),

  me: (params?: MeQuery) => apiRequest<MeResponse>(`/me${accountQuery(params)}`),
  updateMe: (body: UpdateMeRequest) => apiRequest<MeResponse>("/me", { method: "PATCH", body }),
  dataExport: (params?: MeQuery) => apiRequest<DataExportResponse>(`/me/data-export${accountQuery(params)}`),
  balance: (params?: BalanceQuery) => apiRequest<BalanceResponse>(`/accounts/me/balance${accountQuery(params)}`),
  transactions: (params?: TransactionsQuery) => apiRequest<TransactionsResponse>(`/accounts/me/transactions${query(params)}`),
  statement: (params: StatementQuery) =>
    apiRequest<StatementResponse>(
      `/accounts/me/statement?from=${params.from}&to=${params.to}${params.account_id ? `&account_id=${encodeURIComponent(params.account_id)}` : ""}`,
    ),

  createTransfer: (body: CreateTransferRequest) => apiRequest<CreateTransferResponse>("/transfers", { method: "POST", body }),
  transfer: (txUuid: string) => apiRequest<TransferDetailResponse>(`/transfers/${encodeURIComponent(txUuid)}`),

  lookupRib: (rib: string) => apiRequest<RibLookupResponse>(`/lookup/rib/${encodeURIComponent(rib)}`),

  beneficiaries: () => apiRequest<BeneficiariesResponse>("/beneficiaries"),
  createBeneficiary: (body: CreateBeneficiaryRequest) =>
    apiRequest<CreateBeneficiaryResponse>("/beneficiaries", { method: "POST", body }),
  updateBeneficiary: (id: string, body: UpdateBeneficiaryRequest) =>
    apiRequest<UpdateBeneficiaryResponse>(`/beneficiaries/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  deleteBeneficiary: (id: string) => apiRequest<void>(`/beneficiaries/${encodeURIComponent(id)}`, { method: "DELETE" }),

  billers: (category?: string) =>
    apiRequest<BillersResponse>(`/billers${category ? `?category=${encodeURIComponent(category)}` : ""}`),
  payBill: (body: PayBillRequest) => apiRequest<PayBillResponse>("/bill-payments", { method: "POST", body }),
  billPayments: (params?: BillPaymentsQuery) => apiRequest<BillPaymentsResponse>(`/bill-payments${billPaymentsQuery(params)}`),
  billPayment: (txUuid: string) => apiRequest<BillPaymentDetailResponse>(`/bill-payments/${encodeURIComponent(txUuid)}`),

  goals: () => apiRequest<GoalsResponse>("/goals"),
  createGoal: (body: CreateGoalRequest) => apiRequest<Goal>("/goals", { method: "POST", body }),
  fundGoal: (id: string, body: FundGoalRequest) => apiRequest<Goal>(`/goals/${encodeURIComponent(id)}/fund`, { method: "POST", body }),
  deleteGoal: (id: string) => apiRequest<void>(`/goals/${encodeURIComponent(id)}`, { method: "DELETE" }),

  subscriptions: () => apiRequest<SubscriptionsResponse>("/subscriptions"),

  supportRequests: () => apiRequest<SupportRequestsResponse>("/support-requests"),
  createSupportRequest: (body: CreateSupportRequestRequest) => apiRequest<SupportRequest>("/support-requests", { method: "POST", body }),

  disputes: () => apiRequest<DisputesResponse>("/disputes"),
  createDispute: (body: CreateDisputeRequest) => apiRequest<Dispute>("/disputes", { method: "POST", body }),

  moneyRequests: () => apiRequest<MoneyRequestsResponse>("/money-requests"),
  createMoneyRequest: (body: CreateMoneyRequestRequest) =>
    apiRequest<CreateMoneyRequestResponse>("/money-requests", { method: "POST", body }),
  fulfillMoneyRequest: (id: string) =>
    apiRequest<FulfillMoneyRequestResponse>(`/money-requests/${encodeURIComponent(id)}/fulfill`, { method: "POST" }),
  declineMoneyRequest: (id: string) => apiRequest<void>(`/money-requests/${encodeURIComponent(id)}/decline`, { method: "POST" }),

  registerPushToken: (body: RegisterPushTokenRequest) => apiRequest<void>("/push-tokens", { method: "POST", body }),
  notifications: () => apiRequest<NotificationsResponse>("/notifications"),
  markNotificationRead: (id: string) => apiRequest<void>(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST" }),
};
