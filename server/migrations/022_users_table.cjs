// Ship List v2 Phase 8 (savings account) -- extracts a genuine `users`
// table out of `accounts`, which today conflates two concepts: the
// customer (login identity: user_id/email/display_name, one per human)
// and an account (a balance-holding entity: account_id/currency/rib,
// potentially several per customer once savings exists).
//
// This is bigger than "drop the UNIQUE on accounts.user_id" -- 7 other
// tables (customer_credentials, auth_sessions, beneficiaries, devices,
// audit_log, offline_intents x2) have foreign keys pointing AT
// accounts(user_id) as their referenced column, which Postgres requires
// to stay a candidate key (unique) for those FKs to remain valid.
// Verified directly against the live schema (pg_constraint), not assumed
// from the migration files alone -- see docs/adr/0011-users-table-
// extraction.md for the full decision writeup. Simply dropping the
// UNIQUE constraint, as an earlier pass of this Ship List item described,
// would have broken all seven the moment a second accounts row for the
// same user_id existed.
//
// email/display_name move OFF accounts entirely (not duplicated) -- a
// deliberate choice over a denormalized copy per account row, which would
// need to be kept in sync across a customer's checking+savings rows for
// no benefit. Verified low-risk: outside migrations/seed.ts, accounts.email
// had exactly one real reader (the parked /devices/enroll route, updated
// in this same phase) and accounts.display_name's handful of readers
// (me.ts, transfers.ts, lookup.ts) are updated in this same change to
// join users instead.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE users (
        user_id      UUID PRIMARY KEY,
        email        TEXT NOT NULL UNIQUE,
        display_name TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Lossless backfill -- today's data is exactly 1:1 (accounts.user_id is
  // still UNIQUE at this point in the migration), including the mint
  // account and every biller "account" (018_billers.cjs's own comment:
  // "account_id doubles as user_id... a biller never logs in, so it needs
  // no distinct user identity, just a unique row").
  pgm.sql(`
    INSERT INTO users (user_id, email, display_name, created_at)
    SELECT user_id, email, display_name, created_at FROM accounts;
  `);

  // Repoint the 7 FKs that actually mean "the customer," not "an account,"
  // from accounts(user_id) to users(user_id). journal/reservations/
  // transfers/billers/bill_payments' FKs target accounts(account_id), not
  // user_id, and are untouched.
  const REPOINT = [
    { table: "customer_credentials", oldConstraint: "customer_credentials_user_id_fkey", column: "user_id" },
    { table: "auth_sessions", oldConstraint: "auth_sessions_user_id_fkey", column: "user_id" },
    { table: "beneficiaries", oldConstraint: "beneficiaries_owner_user_id_fkey", column: "owner_user_id" },
    { table: "devices", oldConstraint: "devices_user_id_fkey", column: "user_id" },
    { table: "audit_log", oldConstraint: "audit_log_user_id_fkey", column: "user_id" },
    { table: "offline_intents", oldConstraint: "offline_intents_sender_id_fkey", column: "sender_id" },
    { table: "offline_intents", oldConstraint: "offline_intents_receiver_id_fkey", column: "receiver_id" },
  ];
  for (const { table, oldConstraint, column } of REPOINT) {
    pgm.sql(`
      ALTER TABLE ${table} DROP CONSTRAINT ${oldConstraint};
      ALTER TABLE ${table} ADD CONSTRAINT ${oldConstraint} FOREIGN KEY (${column}) REFERENCES users(user_id);
    `);
  }

  // Now safe to drop -- nothing depends on accounts.user_id being unique
  // anymore. accounts.user_id becomes a real FK (it never was one before;
  // uniqueness alone stood in for referential integrity), not unique.
  pgm.sql(`
    ALTER TABLE accounts DROP CONSTRAINT accounts_user_id_key;
    ALTER TABLE accounts ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id);
  `);

  pgm.sql(`
    ALTER TABLE accounts DROP COLUMN email;
    ALTER TABLE accounts DROP COLUMN display_name;
  `);

  pgm.sql(`
    ALTER TABLE accounts
      ADD COLUMN account_type TEXT NOT NULL DEFAULT 'checking'
        CHECK (account_type IN ('checking', 'savings'));
  `);

  // At most one checking + one savings per user.
  pgm.sql(`CREATE UNIQUE INDEX accounts_user_id_account_type_key ON accounts (user_id, account_type);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX accounts_user_id_account_type_key;`);
  pgm.sql(`ALTER TABLE accounts DROP COLUMN account_type;`);
  pgm.sql(`
    ALTER TABLE accounts ADD COLUMN email TEXT;
    ALTER TABLE accounts ADD COLUMN display_name TEXT;
    UPDATE accounts SET email = users.email, display_name = users.display_name
      FROM users WHERE users.user_id = accounts.user_id;
    ALTER TABLE accounts ALTER COLUMN email SET NOT NULL;
    ALTER TABLE accounts ADD CONSTRAINT accounts_email_key UNIQUE (email);
  `);
  pgm.sql(`
    ALTER TABLE accounts DROP CONSTRAINT accounts_user_id_fkey;
    ALTER TABLE accounts ADD CONSTRAINT accounts_user_id_key UNIQUE (user_id);
  `);

  const REPOINT = [
    { table: "customer_credentials", oldConstraint: "customer_credentials_user_id_fkey", column: "user_id" },
    { table: "auth_sessions", oldConstraint: "auth_sessions_user_id_fkey", column: "user_id" },
    { table: "beneficiaries", oldConstraint: "beneficiaries_owner_user_id_fkey", column: "owner_user_id" },
    { table: "devices", oldConstraint: "devices_user_id_fkey", column: "user_id" },
    { table: "audit_log", oldConstraint: "audit_log_user_id_fkey", column: "user_id" },
    { table: "offline_intents", oldConstraint: "offline_intents_sender_id_fkey", column: "sender_id" },
    { table: "offline_intents", oldConstraint: "offline_intents_receiver_id_fkey", column: "receiver_id" },
  ];
  for (const { table, oldConstraint, column } of REPOINT) {
    pgm.sql(`
      ALTER TABLE ${table} DROP CONSTRAINT ${oldConstraint};
      ALTER TABLE ${table} ADD CONSTRAINT ${oldConstraint} FOREIGN KEY (${column}) REFERENCES accounts(user_id);
    `);
  }

  pgm.sql(`DROP TABLE users;`);
};
