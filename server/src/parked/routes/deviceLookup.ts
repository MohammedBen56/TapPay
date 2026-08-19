import { db } from "../db/kysely.js";

/** Shared by /tx/submit and /tx/sync: resolves a raw device_id to its enrolled
 * device row + the account it settles against. Both routes need the exact same
 * "look up device, then its account" step before they can verify a signature or
 * move money against it. */
export async function findDeviceAccount(deviceIdBytes: Buffer) {
  const device = await db
    .selectFrom("devices")
    .select(["user_id", "identity_pubkey", "attestation_ok", "last_seq", "rollback_flagged_at"])
    .where("device_id", "=", deviceIdBytes)
    .executeTakeFirst();
  if (!device) return null;

  const account = await db
    .selectFrom("accounts")
    .select(["account_id", "currency"])
    .where("user_id", "=", device.user_id)
    .executeTakeFirst();
  if (!account) return null;

  return { device, account };
}
