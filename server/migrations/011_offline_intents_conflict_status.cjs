// /tx/sync needs a status distinct from FAILED_INSUFFICIENT for an intent
// rejected because its tx_uuid is already occupied by a DIFFERENT transaction
// (different sender/recipient/amount/currency) -- the transfer()-level
// tx_uuid settlement-slot hijack guard added alongside this migration.
// Overloading FAILED_INSUFFICIENT for a semantically different failure would
// make the audit trail misleading, same reasoning as migration 009. Mirrors
// 009's structure exactly.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE offline_intents DROP CONSTRAINT offline_intents_status_check;`);
  pgm.sql(`
    ALTER TABLE offline_intents
      ADD CONSTRAINT offline_intents_status_check
      CHECK (status IN ('PENDING','SETTLED','FAILED_INSUFFICIENT','FAILED_EXPIRED','FAILED_SEQUENCE_REGRESSION','FAILED_CONFLICT'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE offline_intents DROP CONSTRAINT offline_intents_status_check;`);
  pgm.sql(`
    ALTER TABLE offline_intents
      ADD CONSTRAINT offline_intents_status_check
      CHECK (status IN ('PENDING','SETTLED','FAILED_INSUFFICIENT','FAILED_EXPIRED','FAILED_SEQUENCE_REGRESSION'));
  `);
};
