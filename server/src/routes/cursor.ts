export interface CursorCodec<Tiebreak> {
  encode(createdAt: Date, tiebreak: Tiebreak): string;
  decode(raw: string): { createdAt: Date; tiebreak: Tiebreak } | null;
}

/** Generic keyset-pagination cursor: a base64url-encoded JSON pair of
 * (createdAt, tiebreak), for any route paginating a created_at-ordered
 * feed that needs a deterministic secondary sort key for same-timestamp
 * rows -- me.ts's bigint journal id, billPayments.ts's tx_uuid. The
 * tiebreak doesn't need to be sequential/incrementing, just a stable total
 * order given a fixed value (a UUID string sorts just as validly as a
 * bigint here). */
export function createCursorCodec<Tiebreak>(
  serializeTiebreak: (t: Tiebreak) => string,
  deserializeTiebreak: (s: string) => Tiebreak | null,
): CursorCodec<Tiebreak> {
  return {
    encode(createdAt, tiebreak) {
      return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), tiebreak: serializeTiebreak(tiebreak) })).toString(
        "base64url",
      );
    },
    decode(raw) {
      try {
        const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { createdAt: string; tiebreak: string };
        const createdAt = new Date(parsed.createdAt);
        if (Number.isNaN(createdAt.getTime())) return null;
        const tiebreak = deserializeTiebreak(parsed.tiebreak);
        if (tiebreak === null) return null;
        return { createdAt, tiebreak };
      } catch {
        return null;
      }
    },
  };
}
