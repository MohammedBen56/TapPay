// Set by /tx/sync (M2) the first time a device submits an offline intent whose
// seq doesn't exceed devices.last_seq -- an audit signal (spec calls this
// "flagged for monotonic sequence regression") rather than an automatic account
// freeze: nothing in the spec asks for one, and freezing is much harder to walk
// back than a config-driven policy layered on top of this timestamp later.
// NULL means never flagged; the first flag time is preserved, not overwritten.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE devices ADD COLUMN rollback_flagged_at TIMESTAMPTZ NULL;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE devices DROP COLUMN rollback_flagged_at;`);
};
