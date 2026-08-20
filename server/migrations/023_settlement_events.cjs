// Ship List v2 Wave 2 Phase 3: an outbox table for the IBankAdapter seam
// -- foreshadows real bank webhook delivery (the actual reason
// IBankAdapter exists as a seam at all) without speculatively building
// the whole integration now. Written inside MockBankAdapter.transfer()'s
// existing transaction, same "second, best-effort statement written
// after settlement succeeds" shape 019_bill_payments.cjs's
// bill_payments table already proves out -- mirrors transfers' own
// shape (tx_uuid PRIMARY KEY, one row per settlement) since every
// settlement (P2P transfer AND bill payment) goes through this same
// adapter method.
//
// No consumer exists yet -- this migration is deliberately just the
// table. A future real bank-webhook delivery worker (or, per Ship List
// v2's Postgres-job-queue item, a queue-based one if that's ever built)
// would drain this table; that's a separate, not-yet-scoped piece of
// work.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE settlement_events (
        tx_uuid         UUID PRIMARY KEY,
        from_account_id UUID NOT NULL REFERENCES accounts(account_id),
        to_account_id   UUID NOT NULL REFERENCES accounts(account_id),
        amount          BIGINT NOT NULL,
        currency        CHAR(3) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX idx_settlement_events_created_at ON settlement_events (created_at);`);

  // Same append-only posture as journal/transfers/audit_log -- an outbox
  // row is a historical fact the moment it's written; the app role never
  // needs to mutate or delete one.
  pgm.sql(`REVOKE UPDATE, DELETE, TRUNCATE ON settlement_events FROM tappay_app;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE settlement_events;`);
};
