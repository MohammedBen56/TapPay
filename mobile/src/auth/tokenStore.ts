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

// Ship List v2: client.ts's refresh-and-retry clears tokens here when a
// refresh definitively fails (expired, or revoked -- e.g. the user
// revoked this exact session from the new "Manage devices" screen, or a
// password change elsewhere revoked every session). Previously nothing
// told AuthContext this happened, so `status` stayed "signedIn" in React
// state while every subsequent request silently 401'd forever. AuthContext
// registers a handler on mount; client.ts calls notifySessionExpired()
// only on a definitive refresh failure, never on an ordinary logout
// (which already drives its own status transition directly).
let onSessionExpired: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

export function notifySessionExpired(): void {
  onSessionExpired?.();
}
