/** Module-level token holder, read directly by src/api/client.ts's fetch
 * wrapper so every request can attach the current access token / trigger a
 * refresh without threading React context through a non-component module.
 * AuthContext (src/auth/AuthContext.tsx) is the only writer -- it mirrors
 * this into React state for rendering, but this is the source of truth for
 * "what token do outgoing requests use right now." */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

let current: Tokens | null = null;

export function getTokens(): Tokens | null {
  return current;
}

export function setTokens(tokens: Tokens | null): void {
  current = tokens;
}
