import { ribToIban } from "@tappay/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bankAdapter } from "../adapters/index.js";
import { db } from "../db/kysely.js";

const transactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().optional(),
});

interface TransactionCursor {
  createdAt: Date;
  id: bigint;
}

function encodeCursor(createdAt: Date, id: bigint): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id: id.toString() })).toString("base64url");
}

function decodeCursor(raw: string): TransactionCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { createdAt: string; id: string };
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: BigInt(parsed.id) };
  } catch {
    return null;
  }
}

/** GET /me, and the two account-scoped reads (balance, transaction history)
 * that make up the Home screen (docs/TapPay_v2_Technical_Design.md §5).
 * Every route here is `me`-scoped from the access token's `aid`/`sub`
 * claims, never a client-supplied account id -- zero IDOR surface, unlike
 * the parked GET /accounts/:accountId/balance this replaces functionally
 * (that route stays live too, unauthenticated, until nothing references it
 * -- see routes/tx.ts's own doc comment). */
export function registerMeRoutes(app: FastifyInstance): void {
  app.get("/me", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { aid: accountId, cid: customerId } = request.user;
    const account = await db
      .selectFrom("accounts")
      .select(["display_name", "rib", "currency"])
      .where("account_id", "=", accountId)
      .executeTakeFirst();

    if (!account || !account.rib || !account.display_name) {
      // A real logged-in customer always has both -- seed.ts sets them at
      // provisioning time. Fail closed rather than expose a partial profile.
      return reply.status(404).send({ error: "IncompleteProfile", message: "account profile is missing required fields" });
    }

    return reply.send({
      customer_id: customerId,
      display_name: account.display_name,
      account_id: accountId,
      rib: account.rib,
      iban: ribToIban(account.rib),
      currency: account.currency,
    });
  });

  app.get("/accounts/me/balance", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { aid: accountId } = request.user;
    const { currency } = request.query as { currency?: string };
    const balance = await bankAdapter.getAvailableBalance(accountId, currency ?? "MAD");
    return reply.send({ account_id: accountId, currency: currency ?? "MAD", available_balance: balance.toString() });
  });

  app.get("/accounts/me/transactions", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { aid: accountId } = request.user;
    const parsed = transactionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "InvalidRequest", message: parsed.error.message });
    }
    const { limit, before } = parsed.data;

    let cursor: TransactionCursor | null = null;
    if (before !== undefined) {
      cursor = decodeCursor(before);
      if (!cursor) {
        return reply.status(400).send({ error: "InvalidRequest", message: "malformed cursor" });
      }
    }

    // Self-join on tx_uuid to find the counterparty's own journal row for the
    // same transaction (exactly one other row per tx_uuid -- self-payment is
    // structurally impossible, CLAUDE.md §5). LEFT JOIN transfers so seeded
    // or legacy rows with no reference still render, just with a null one.
    let query = db
      .selectFrom("journal as j")
      .innerJoin("journal as o", (join) => join.onRef("o.tx_uuid", "=", "j.tx_uuid").on("o.account_id", "!=", accountId))
      .leftJoin("accounts as counterparty", "counterparty.account_id", "o.account_id")
      .leftJoin("transfers as t", "t.tx_uuid", "j.tx_uuid")
      .select([
        "j.id as id",
        "j.tx_uuid as tx_uuid",
        "j.amount as amount",
        "j.currency as currency",
        "j.created_at as created_at",
        "counterparty.display_name as counterparty_name",
        "counterparty.rib as counterparty_rib",
        "t.reference as reference",
      ])
      .where("j.account_id", "=", accountId)
      .orderBy("j.created_at", "desc")
      .orderBy("j.id", "desc")
      .limit(limit + 1);

    if (cursor) {
      const { createdAt, id } = cursor;
      query = query.where((eb) =>
        eb.or([eb("j.created_at", "<", createdAt), eb.and([eb("j.created_at", "=", createdAt), eb("j.id", "<", id)])]),
      );
    }

    const rows = await query.execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return reply.send({
      transactions: page.map((r) => ({
        tx_uuid: r.tx_uuid,
        direction: r.amount < 0n ? "debit" : "credit",
        amount: (r.amount < 0n ? -r.amount : r.amount).toString(),
        currency: r.currency,
        counterparty_name: r.counterparty_name,
        counterparty_rib: r.counterparty_rib,
        reference: r.reference,
        created_at: r.created_at.toISOString(),
      })),
      next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    });
  });
}
