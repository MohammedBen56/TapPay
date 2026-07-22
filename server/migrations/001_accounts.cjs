/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

// The genesis/mint account: how money enters the ledger without breaking the
// sum-to-zero invariant. Seed data (server/scripts/seed.ts) credits demo accounts
// via ordinary paired journal transfers FROM this account, so every tx_uuid --
// including seed data -- sums to exactly zero, with no special-cased exception
// anywhere in the ledger or its tests. It is allowed to run arbitrarily negative;
// that's enforced in application code (MockBankAdapter), not a DB constraint.
// Its id is the nil UUID, mirrored as MINT_ACCOUNT_ID in server/src/db/kysely.ts.

exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

  pgm.sql(`
    CREATE TABLE accounts (
        account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL UNIQUE,
        email      TEXT NOT NULL UNIQUE,
        currency   CHAR(3) NOT NULL DEFAULT 'MAD',
        is_mint    BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Exactly one mint account may ever exist.
  pgm.sql(`
    CREATE UNIQUE INDEX idx_accounts_single_mint ON accounts (is_mint) WHERE is_mint = true;
  `);

  pgm.sql(`
    INSERT INTO accounts (account_id, user_id, email, currency, is_mint)
    VALUES ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 'mint@tappay.local', 'MAD', true);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE accounts;`);
};
