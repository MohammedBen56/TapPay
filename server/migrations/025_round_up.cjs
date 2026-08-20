// Ship List v2 Wave 2 Phase 5: opt-in round-up savings preference, per
// customer identity (not per-account -- a user's round-up preference
// applies once, regardless of which checking-account debit triggers it).
// See server/src/roundup.ts for the sweep logic this flag gates.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE users ADD COLUMN round_up_enabled BOOLEAN NOT NULL DEFAULT false;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE users DROP COLUMN round_up_enabled;`);
};
