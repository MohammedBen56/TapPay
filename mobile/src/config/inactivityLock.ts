/** How long the app can sit backgrounded before the next foreground return
 * requires re-authentication (AuthContext's "locked" status). Config-driven
 * per CLAUDE.md §8 -- a dedicated, documented constant, not a magic number
 * inline in AuthContext -- matching this directory's existing serverUrl.ts
 * convention (mobile has no runtime env-var system the way the server
 * does, so "config" here means "easy to find and change," not "read from
 * an env var").
 *
 * 60 seconds, not a longer bank-app-typical value (2-5 minutes): this app
 * has no PIN-entry fallback yet, only biometric-or-password, so a shorter
 * window trades a bit of re-auth friction for a smaller real-world window
 * where a picked-up, still-foregrounded-a-moment-ago phone shows account
 * data without a fresh unlock. Revisit alongside a PIN-entry addition if
 * this proves too aggressive in practice. */
export const INACTIVITY_LOCK_THRESHOLD_MS = 60_000;
