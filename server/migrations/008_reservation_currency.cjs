// reserve()/transfer() are given a currency at call time but the base schema has
// nowhere to persist it on the hold itself, forcing commit() to indirectly infer it
// from the account instead of using what was actually reserved. MVP is single
// currency in practice, but a reservation should still record what it's a hold of.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE reservations ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'MAD';`);
  pgm.sql(`ALTER TABLE reservations ALTER COLUMN currency DROP DEFAULT;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE reservations DROP COLUMN currency;`);
};
