// The public IBankAdapter.commit(txUuid) takes no recipient parameter (spec §2.1,
// binding interface). A reservation with no known counterparty cannot be committed
// into a balanced journal entry without breaking sum-to-zero -- so commit() must be
// able to learn the counterparty from the reservation row itself. reserve() (the
// public 5-arg method) leaves this NULL, since it genuinely doesn't know one;
// transfer() populates it internally. commit() on a NULL-counterparty reservation
// fails closed with "no_counterparty" rather than guessing -- see MockBankAdapter.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE reservations
      ADD COLUMN counterparty_account_id UUID REFERENCES accounts(account_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE reservations DROP COLUMN counterparty_account_id;`);
};
