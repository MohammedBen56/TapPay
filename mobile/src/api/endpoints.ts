import type {
  BalanceResponse,
  BeneficiariesResponse,
  CreateBeneficiaryRequest,
  CreateBeneficiaryResponse,
  CreateTransferRequest,
  CreateTransferResponse,
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  MeResponse,
  RefreshRequest,
  RefreshResponse,
  RibLookupResponse,
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

export const api = {
  login: (body: LoginRequest) => apiRequest<LoginResponse>("/auth/login", { method: "POST", body, auth: false }),
  refresh: (body: RefreshRequest) => apiRequest<RefreshResponse>("/auth/refresh", { method: "POST", body, auth: false }),
  logout: (body: LogoutRequest) => apiRequest<void>("/auth/logout", { method: "POST", body }),

  me: () => apiRequest<MeResponse>("/me"),
  balance: () => apiRequest<BalanceResponse>("/accounts/me/balance"),
  transactions: (params?: TransactionsQuery) => apiRequest<TransactionsResponse>(`/accounts/me/transactions${query(params)}`),

  createTransfer: (body: CreateTransferRequest) => apiRequest<CreateTransferResponse>("/transfers", { method: "POST", body }),
  transfer: (txUuid: string) => apiRequest<TransferDetailResponse>(`/transfers/${encodeURIComponent(txUuid)}`),

  lookupRib: (rib: string) => apiRequest<RibLookupResponse>(`/lookup/rib/${encodeURIComponent(rib)}`),

  beneficiaries: () => apiRequest<BeneficiariesResponse>("/beneficiaries"),
  createBeneficiary: (body: CreateBeneficiaryRequest) =>
    apiRequest<CreateBeneficiaryResponse>("/beneficiaries", { method: "POST", body }),
  updateBeneficiary: (id: string, body: UpdateBeneficiaryRequest) =>
    apiRequest<UpdateBeneficiaryResponse>(`/beneficiaries/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  deleteBeneficiary: (id: string) => apiRequest<void>(`/beneficiaries/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
