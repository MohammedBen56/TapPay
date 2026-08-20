/** Typed fetch wrapper for the v2 neobank routes. Attaches the current
 * access token, and on a 401 (any authed route past login) performs a
 * single, single-flight refresh-and-retry: concurrent 401s from several
 * in-flight requests share one `/auth/refresh` call rather than each
 * racing their own (which would each rotate the refresh token and cause
 * all but the first to fail with InvalidRefreshToken). */
import type { ApiErrorBody, RefreshResponse } from "@tappay/shared";
import { SERVER_BASE_URL } from "../config/serverUrl";
import { getTokens, notifySessionExpired, setTokens } from "../auth/tokenStore";

// Ship List v2 Wave 2 Phase 3: the live v2 API moved under /v1 (server/src/
// app.ts) -- /health*/metrics stay unprefixed, but this app never calls
// those directly (confirmed), so every apiRequest()/refresh call gets the
// prefix unconditionally.
const API_BASE_URL = `${SERVER_BASE_URL}/v1`;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorBody["error"] | "NetworkError" | "Unauthenticated",
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const tokens = getTokens();
  if (!tokens) return null;

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: tokens.refreshToken }),
        });
        if (!res.ok) {
          setTokens(null);
          notifySessionExpired();
          return null;
        }
        const body = (await res.json()) as RefreshResponse;
        setTokens({ accessToken: body.access_token, refreshToken: body.refresh_token });
        return body.access_token;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Set false for /auth/login and /auth/refresh, which carry no bearer token. */
  auth?: boolean;
}

async function doFetch(path: string, options: ApiRequestOptions, accessToken: string | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.auth !== false && accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  return fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await doFetch(path, options, getTokens()?.accessToken ?? null);
  } catch {
    throw new ApiError(0, "NetworkError", "could not reach the server");
  }

  if (options.auth !== false && response.status === 401) {
    const newAccessToken = await refreshAccessToken();
    if (!newAccessToken) {
      throw new ApiError(401, "Unauthenticated", "session expired, please sign in again");
    }
    try {
      response = await doFetch(path, options, newAccessToken);
    } catch {
      throw new ApiError(0, "NetworkError", "could not reach the server");
    }
  }

  if (!response.ok) {
    let body: ApiErrorBody;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = { error: "InvalidRequest", message: response.statusText || "request failed" };
    }
    throw new ApiError(response.status, body.error, body.message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
