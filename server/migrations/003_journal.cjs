exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE journal (
        id         BIGSERIAL PRIMARY KEY,
        tx_uuid    UUID NOT NULL,
        account_id UUID NOT NULL REFERENCES accounts(account_id),
        amount     BIGINT NOT NULL,                   -- signed minor units (+credit, -debit)
        currency   CHAR(3) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT unique_tx_account UNIQUE (tx_uuid, account_id)
    );
  `);
  pgm.sql(`CREATE INDEX idx_journal_account_created ON journal(account_id, created_at);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE journal;`);
};
