import { db } from "./db/kysely.js";

/**
 * Ship List v2 Wave 2 Phase 8: push notifications. `notify()` is the one
 * delivery function every triggering event (a money request created or
 * fulfilled, so far) calls -- an in-process function call, deliberately
 * NOT wired through a Postgres-backed job queue: nothing in this app
 * produces enough notification volume yet to need durable retry/backoff
 * infrastructure, and `docs/SHIP_LIST_V2.md`'s own re-scoping of the
 * job-queue item already defers that build until something real needs
 * it. If that day comes, this function is exactly what would move
 * behind a queue -- noted here, not spent effort on speculatively now.
 *
 * Always writes the in-app notification row first (best-effort, matching
 * `roundup.ts`'s posture: never let this fail the caller's own already-
 * successful action) -- this is what makes the notification CENTER a
 * real, demoable feature regardless of whether live push delivery works
 * on any given device. Live push delivery (Expo's push service, a plain
 * HTTPS POST -- no new external account needed for the SERVER-side send,
 * since this is already an Expo-managed app) is attempted only if the
 * user has at least one registered token, and is itself best-effort: a
 * failed push send never throws out of this function.
 *
 * **The real, stated boundary**: obtaining a device's Expo push token via
 * `expo-notifications`' `getExpoPushTokenAsync()` requires a valid EAS
 * project id, and `mobile/app.config.js`'s `extra.eas.projectId` is
 * confirmed still unset (the same account-ownership boundary Ship List v2
 * Phase 7's release signing already hit and deliberately left to the
 * owner). Registration code (mobile/src/push/pushToken.ts) is written
 * and typechecked; no device will ever actually have a token registered
 * until the owner links their own EAS project, so `push_tokens` stays
 * empty and every notify() call takes the in-app-only path in practice.
 * That's expected, not a bug -- it's exactly this function's designed
 * degrade-gracefully behavior.
 */
export interface NotifyLogger {
  error: (obj: unknown, msg?: string) => void;
}

export async function notify(
  userId: string,
  title: string,
  body: string,
  data: Record<string, unknown> | undefined,
  logger?: NotifyLogger,
): Promise<void> {
  await db
    .insertInto("notifications")
    .values({ user_id: userId, title, body, data: data ? JSON.stringify(data) : null })
    .execute();

  const tokens = await db.selectFrom("push_tokens").select(["token"]).where("user_id", "=", userId).execute();
  if (tokens.length === 0) return;

  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(tokens.map((t) => ({ to: t.token, title, body, data }))),
    });
  } catch (err) {
    (logger ?? console).error(err, "push delivery failed (non-fatal -- the in-app notification row is already written)");
  }
}
