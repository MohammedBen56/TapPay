import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, MINT_ACCOUNT_ID } from "../kysely.js";

// node-postgres returns BIGINT (oid 20) as a string by default, and can be finicky
// binding a native JS BigInt as a query parameter. Both directions are asserted here,
// not just the read side -- see kysely.ts's setTypeParser comment for why this line
// is load-bearing for "money is bigint, never float".
describe("bigint round-trip through pg/kysely", () => {
  it("writes and reads back a bigint larger than Number.MAX_SAFE_INTEGER unchanged", async () => {
    // Chosen specifically because it can't survive a silent float coercion: this
    // value and largeAmount + 1 both round to the same IEEE-754 double, so a bigint
    // that got silently downcast to Number anywhere in the round-trip would come
    // back wrong (or would have collided with a neighboring value) without tripping
    // an obvious type error.
    const largeAmount = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2

    const rollbackMarker = new Error("intentional rollback -- test cleanup, not a real failure");

    await expect(
      db.transaction().execute(async (trx) => {
        const txUuid = randomUUID();
        await trx
          .insertInto("journal")
          .values({
            tx_uuid: txUuid,
            account_id: MINT_ACCOUNT_ID,
            amount: largeAmount,
            currency: "MAD",
          })
          .execute();

        const row = await trx
          .selectFrom("journal")
          .select("amount")
          .where("tx_uuid", "=", txUuid)
          .executeTakeFirstOrThrow();

        expect(typeof row.amount).toBe("bigint");
        expect(row.amount).toBe(largeAmount);

        throw rollbackMarker;
      }),
    ).rejects.toBe(rollbackMarker);
  });
});
