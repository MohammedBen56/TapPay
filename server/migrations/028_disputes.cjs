// Ship List v2 Wave 2 Phase 6: "flag this transaction" off the receipt
// screen. Deliberately never touches money movement -- a dispute is a
// review request, not a reversal mechanism (this app has no chargeback/
// reversal machinery, and building one is well outside this feature's
// scope). status starts and stays 'open' until reviewed out-of-band,
// matching docs/INCIDENT_RESPONSE.md's single-owner-review reality, same
// posture as support_requests (027_support_requests.cjs).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE disputes (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(user_id),
        tx_uuid     UUID NOT NULL,
        reason      TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, tx_uuid)
    );
  `);

  pgm.sql(`CREATE INDEX idx_disputes_user_id ON disputes (user_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE disputes;`);
};
