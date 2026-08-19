// A separate table, not columns on accounts (CLAUDE.md §4's v2 design doc):
// the mint account has no customer and must never need a fake password hash
// to satisfy a NOT NULL. customer_id is the bank-issued login identifier
// (8-digit, provisioned by server/scripts/seed.ts -- "as a real bank would
// hand you credentials", not self-service signup); user_id is the same
// FK-to-accounts(user_id) join key devices already uses.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE customer_credentials (
        customer_id      TEXT PRIMARY KEY,
        user_id          UUID NOT NULL UNIQUE REFERENCES accounts(user_id),
        password_hash    TEXT NOT NULL,
        failed_attempts  INT NOT NULL DEFAULT 0,
        locked_until     TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE customer_credentials;`);
};
