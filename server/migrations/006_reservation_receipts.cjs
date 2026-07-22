// Idempotent resubmission (spec §2.3: "returns the existing signed COSE_Sign1
// receipt") needs somewhere to persist the receipt bytes so a replay returns the
// *same* bytes rather than a fresh (differently-randomized ECDSA) signature over
// the same facts. The base schema has nowhere to put this; reservations is the
// natural home since it's already keyed by tx_uuid 1:1.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE reservations
      ADD COLUMN receipt_signature BYTEA,
      ADD COLUMN settled_at TIMESTAMPTZ;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE reservations
      DROP COLUMN receipt_signature,
      DROP COLUMN settled_at;
  `);
};
