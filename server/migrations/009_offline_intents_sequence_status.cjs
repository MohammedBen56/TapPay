// M2 (/tx/sync) needs a status distinct from FAILED_EXPIRED for an intent rejected
// because its seq didn't advance past devices.last_seq (the anti-rollback check
// ADV-03 exercises) -- overloading FAILED_EXPIRED for a semantically different
// failure would make the audit trail misleading. offline_intents is unused in
// production so widening the CHECK constraint here is a clean addition, not a
// breaking change.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE offline_intents DROP CONSTRAINT offline_intents_status_check;`);
  pgm.sql(`
    ALTER TABLE offline_intents
      ADD CONSTRAINT offline_intents_status_check
      CHECK (status IN ('PENDING','SETTLED','FAILED_INSUFFICIENT','FAILED_EXPIRED','FAILED_SEQUENCE_REGRESSION'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE offline_intents DROP CONSTRAINT offline_intents_status_check;`);
  pgm.sql(`
    ALTER TABLE offline_intents
      ADD CONSTRAINT offline_intents_status_check
      CHECK (status IN ('PENDING','SETTLED','FAILED_INSUFFICIENT','FAILED_EXPIRED'));
  `);
};
