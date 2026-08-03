import { randomUUID, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { uuidToBytes, type Signer } from "@tappay/shared";
import { compressedPublicKeyFromKeyObject } from "../../crypto/ecPublicKey.js";
import { db, MINT_ACCOUNT_ID } from "../../db/kysely.js";

export interface TestDevice {
  deviceId: string;
  accountId: string;
  signer: Signer;
}

/** Shared by tx.test.ts and sync.test.ts: seeds a device directly with
 * attestation_ok: true, bypassing the real /devices/enroll flow -- attestation
 * verification correctness is covered by attestation/__tests__/verify.test.ts;
 * these route tests are specifically about /tx/submit and /tx/sync's own
 * responsibilities, and no real Android attestation chain is available in this
 * environment to exercise the full enroll -> submit/sync pipeline end-to-end. */
export async function createEnrolledDevice(startingBalance: bigint): Promise<TestDevice> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const compressedPublicKey = compressedPublicKeyFromKeyObject(publicKey);
  const deviceId = randomUUID();
  const accountId = randomUUID();
  const userId = randomUUID();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("accounts")
      .values({ account_id: accountId, user_id: userId, email: `test-${randomUUID()}@tappay.local`, currency: "MAD" })
      .execute();
    await trx
      .insertInto("devices")
      .values({
        device_id: Buffer.from(uuidToBytes(deviceId)),
        user_id: userId,
        identity_pubkey: Buffer.from(compressedPublicKey),
        platform: "android",
        attestation_blob: JSON.stringify({ test: true }),
        attestation_ok: true,
      })
      .execute();
    if (startingBalance > 0n) {
      const txUuid = randomUUID();
      await trx
        .insertInto("journal")
        .values([
          { tx_uuid: txUuid, account_id: MINT_ACCOUNT_ID, amount: -startingBalance, currency: "MAD" },
          { tx_uuid: txUuid, account_id: accountId, amount: startingBalance, currency: "MAD" },
        ])
        .execute();
    }
  });

  const signer: Signer = async (bytesToSign) =>
    new Uint8Array(nodeSign("sha256", bytesToSign, { key: privateKey, dsaEncoding: "ieee-p1363" }));

  return { deviceId, accountId, signer };
}
