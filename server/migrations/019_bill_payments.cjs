// One row per bill payment, keyed by tx_uuid -- structured metadata
// (which biller, what subscriber/contract reference) alongside the
// settlement that already exists in journal/transfers once
// MockBankAdapter.transfer() runs (server/src/routes/billPayments.ts
// inserts this row as a second, best-effort statement AFTER a successful
// transfer() call, mirroring how transfers.ts's own reference row is
// written -- see 016_transfers.cjs's comment for why that duplication is
// safe: correlation is enforced at the application layer, not a DB
// constraint spanning both writes).
//
// Deliberately does NOT duplicate amount/currency (unlike transfers,
// which duplicates journal's amount for a documented hot-path reason) --
// bill payment reads are a low-traffic reporting path, so joining against
// transfers for those fields is fine and avoids a second source of truth.
//
// UPDATE/DELETE revoked for the app role, same as transfers -- a
// settlement-adjacent record whose whole point is that it never changes
// once written (see 017_app_role.cjs).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE bill_payments (
        tx_uuid               UUID PRIMARY KEY REFERENCES transfers(tx_uuid),
        account_id             UUID NOT NULL REFERENCES accounts(account_id),
        biller_id               UUID NOT NULL REFERENCES billers(id),
        subscriber_reference   TEXT NOT NULL,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX idx_bill_payments_account ON bill_payments (account_id, created_at);`);

  pgm.sql(`REVOKE UPDATE, DELETE, TRUNCATE ON bill_payments FROM tappay_app;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE bill_payments;`);
};
