// Transfer metadata -- specifically the human-readable reference/reason
// string -- lives here, keyed once by tx_uuid, rather than as a column on
// journal (CLAUDE.md §4's v2 design doc). journal is this codebase's most
// adversarially-tested surface (sum-to-zero pairs, UNIQUE(tx_uuid,
// account_id), the 100-concurrent-transfer deadlock stress test) and stays
// structurally untouched by this migration. A history read pays one extra
// join against journal's existing (account_id, created_at) index; the
// alternative (denormalizing reference onto both journal rows) risks the two
// rows silently diverging for zero benefit.
//
// No FK to journal: journal's key is the composite (tx_uuid, account_id), so
// a single tx_uuid can't FK against it directly. The two are correlated at
// the application layer -- MockBankAdapter.transfer() inserts both the
// journal pair and this row in the same DB transaction (see M1e), so a
// settled transfer can never exist without its reference.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE transfers (
        tx_uuid          UUID PRIMARY KEY,
        from_account_id  UUID NOT NULL REFERENCES accounts(account_id),
        to_account_id    UUID NOT NULL REFERENCES accounts(account_id),
        amount           BIGINT NOT NULL CHECK (amount > 0),
        currency         CHAR(3) NOT NULL,
        reference        TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX idx_transfers_from_account ON transfers (from_account_id, created_at);`);
  pgm.sql(`CREATE INDEX idx_transfers_to_account ON transfers (to_account_id, created_at);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE transfers;`);
};
