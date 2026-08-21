// Ship List v2 Wave 2 Phase 7: "request money" core. A request always
// names a specific target (resolved the same way a transfer resolves a
// recipient -- by RIB or beneficiary id, at creation time), not an
// open-to-anyone QR broadcast -- see server/src/routes/moneyRequests.ts's
// own comment for the reasoning. Fulfilling a request settles via the
// existing bankAdapter.transfer() unchanged: a fulfilled request is
// structurally an ordinary transfer with the requester as recipient.
//
// No 'expired' status, despite the original plan naming one -- nothing
// in this phase sweeps/expires a stale request (no sweeper wiring), and
// CLAUDE.md's own discipline is to not build an unreachable enum value
// implying functionality that doesn't exist. A real expiry job is a
// named, deferred follow-up (see docs/SHIP_LIST_V2.md), not silently
// dropped.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE money_requests (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        requester_user_id      UUID NOT NULL REFERENCES users(user_id),
        requester_account_id   UUID NOT NULL REFERENCES accounts(account_id),
        target_user_id         UUID NOT NULL REFERENCES users(user_id),
        amount                 BIGINT NOT NULL CHECK (amount > 0),
        currency               CHAR(3) NOT NULL,
        reference              TEXT NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'declined')),
        tx_uuid                UUID,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX idx_money_requests_requester_user_id ON money_requests (requester_user_id);`);
  pgm.sql(`CREATE INDEX idx_money_requests_target_user_id ON money_requests (target_user_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE money_requests;`);
};
