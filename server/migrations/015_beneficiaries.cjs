// Saved recipients for the Send flow. Stores the RIB, not a resolved
// account_id (CLAUDE.md §4's v2 design doc): a beneficiary is a typed bank
// coordinate, resolved against accounts.rib at send time, exactly as a real
// bank does -- so it stays valid even if the underlying account_id churns,
// and so entries added via manual RIB entry and entries added by picking an
// existing contact are stored identically.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE beneficiaries (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id  UUID NOT NULL REFERENCES accounts(user_id),
        display_name   TEXT NOT NULL,
        rib            CHAR(24) NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_user_id, rib)
    );
  `);

  pgm.sql(`CREATE INDEX idx_beneficiaries_owner ON beneficiaries (owner_user_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE beneficiaries;`);
};
