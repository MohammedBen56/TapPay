import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createDb, MINT_ACCOUNT_ID } from "../kysely.js";
import { config } from "../../config.js";

// The migration (017_app_role.cjs) is not the proof -- this is. A migration
// that assumes its own GRANTs/REVOKEs took effect is a hope; connecting AS
// the app role and asserting a write actually fails with the exact SQLSTATE
// is what makes the append-only guarantee a tested property instead of a
// comment. This test intentionally opens its own connection using
// config.appDatabaseUrl (the tappay_app role) rather than the ambient `db`
// export, precisely so it exercises the real, restricted credential the app
// itself connects with in production -- not the schema-owning role every
// other test file's `db` import uses.
describe("tappay_app database role privileges", () => {
  it("can SELECT and INSERT on journal, but not UPDATE, DELETE, or TRUNCATE it", async () => {
    const appDb = createDb(config.appDatabaseUrl);
    try {
      // SELECT: allowed.
      await expect(appDb.selectFrom("journal").select("id").limit(1).execute()).resolves.toBeDefined();

      // INSERT: allowed -- this is the one legitimate write path, and it's
      // exactly how MockBankAdapter settles a transfer.
      const accountId = randomUUID();
      const userId = randomUUID();
      await appDb.insertInto("users").values({ user_id: userId, email: `test-${randomUUID()}@tappay.local` }).execute();
      await appDb.insertInto("accounts").values({ account_id: accountId, user_id: userId, currency: "MAD" }).execute();
      const txUuid = randomUUID();
      await expect(
        appDb
          .insertInto("journal")
          .values([
            { tx_uuid: txUuid, account_id: MINT_ACCOUNT_ID, amount: -100n, currency: "MAD" },
            { tx_uuid: txUuid, account_id: accountId, amount: 100n, currency: "MAD" },
          ])
          .execute(),
      ).resolves.toBeDefined();

      // UPDATE: rejected at the database level, not just by application logic.
      await expect(appDb.updateTable("journal").set({ amount: 999n }).where("tx_uuid", "=", txUuid).execute()).rejects.toMatchObject({
        code: "42501", // insufficient_privilege
      });

      // DELETE: same.
      await expect(appDb.deleteFrom("journal").where("tx_uuid", "=", txUuid).execute()).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await appDb.destroy();
    }
  });

  it("cannot TRUNCATE journal or transfers", async () => {
    const appDb = createDb(config.appDatabaseUrl);
    try {
      await expect(sql`truncate journal`.execute(appDb)).rejects.toMatchObject({ code: "42501" });
      await expect(sql`truncate transfers`.execute(appDb)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await appDb.destroy();
    }
  });
});
