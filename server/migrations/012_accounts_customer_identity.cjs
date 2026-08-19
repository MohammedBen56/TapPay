// v2 pivot (CLAUDE.md §4): the mock neobank MVP needs a human-facing display
// name and a typeable, self-checking account identifier -- a 24-digit
// Moroccan RIB (packages/shared/src/rib.ts, IBAN mod-97-10 check math, bank
// code 999 deliberately unassigned so nothing resembles a real Moroccan
// bank). Both columns are nullable: the seeded nil-UUID mint account
// (001_accounts.cjs) has neither a customer nor a RIB, and must keep working
// unmodified.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE accounts
      ADD COLUMN display_name TEXT,
      ADD COLUMN rib CHAR(24) UNIQUE CHECK (rib ~ '^[0-9]{24}$');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE accounts DROP COLUMN display_name, DROP COLUMN rib;`);
};
