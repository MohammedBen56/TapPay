import type { UseQueryOptions } from "@tanstack/react-query";
import type { BillersResponse, MeResponse } from "@tappay/shared";
import { api } from "./endpoints";

/** Shared query-option objects for cache keys read from more than one
 * screen -- centralized so every call site agrees on one staleness policy
 * per key (React Query has exactly one cache entry per queryKey; setting
 * staleTime ad-hoc at each call site means whichever screen mounts first
 * silently wins until the next refetch). Longer than the app's 15s global
 * default (app/_layout.tsx) because both are near-static: `me` only
 * changes on a rare profile edit, `billers` only changes via a migration. */

export const meQueryOptions: UseQueryOptions<MeResponse> = {
  queryKey: ["me"],
  queryFn: () => api.me(),
  staleTime: 5 * 60_000,
};

export function billersQueryOptions(category?: string): UseQueryOptions<BillersResponse> {
  return {
    queryKey: ["billers", category ?? "all"],
    queryFn: () => api.billers(category),
    staleTime: 30 * 60_000,
  };
}
