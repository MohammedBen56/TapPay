exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE reservations (
        tx_uuid    UUID PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES accounts(account_id),
        amount     BIGINT NOT NULL CHECK (amount > 0),
        expires_at TIMESTAMPTZ NOT NULL,
        state      TEXT NOT NULL CHECK (state IN ('HELD','COMMITTED','RELEASED')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_reservations_expiry ON reservations(expires_at) WHERE state = 'HELD';`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE reservations;`);
};
