import type {
  BalanceResponse,
  BeneficiariesResponse,
  BillersResponse,
  BillPaymentDetailResponse,
  BillPaymentsQuery,
  BillPaymentsResponse,
  ChangePasswordRequest,
  CreateBeneficiaryRequest,
  CreateBeneficiaryResponse,
  CreateTransferRequest,
  CreateTransferResponse,
  DataExportResponse,
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  MeResponse,
  PayBillRequest,
  PayBillResponse,
  RefreshRequest,
  RefreshResponse,
  RibLookupResponse,
  SessionsResponse,
  StatementQuery,
  StatementResponse,
  TransactionsQuery,
  TransactionsResponse,
  TransferDetailResponse,
  UpdateBeneficiaryRequest,
  UpdateBeneficiaryResponse,
} from "@tappay/shared";
import { apiRequest } from "./client";

function query(params: TransactionsQuery = {}): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.before !== undefined) search.set("before", params.before);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

function billPaymentsQuery(params: BillPaymentsQuery = {}): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.before !== undefined) search.set("before", params.before);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  login: (body: LoginRequest) => apiRequest<LoginResponse>("/auth/login", { method: "POST", body, auth: false }),
  refresh: (body: RefreshRequest) => apiRequest<RefreshResponse>("/auth/refresh", { method: "POST", body, auth: false }),
  logout: (body: LogoutRequest) => apiRequest<void>("/auth/logout", { method: "POST", body }),
  changePassword: (body: ChangePasswordRequest) => apiRequest<void>("/auth/change-password", { method: "POST", body }),
  sessions: () => apiRequest<SessionsResponse>("/auth/sessions"),
  revokeSession: (id: string) => apiRequest<void>(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),

  me: () => apiRequest<MeResponse>("/me"),
  dataExport: () => apiRequest<DataExportResponse>("/me/data-export"),
  balance: () => apiRequest<BalanceResponse>("/accounts/me/balance"),
  transactions: (params?: TransactionsQuery) => apiRequest<TransactionsResponse>(`/accounts/me/transactions${query(params)}`),
  statement: (params: StatementQuery) =>
    apiRequest<StatementResponse>(`/accounts/me/statement?from=${params.from}&to=${params.to}`),

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
};
