// Unused until M2 (Mode C reconciliation), created now since it's in the same
// migration set and cheap to add alongside the rest of the schema.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE offline_intents (
        tx_uuid       UUID PRIMARY KEY,
        sender_id     UUID NOT NULL REFERENCES accounts(user_id),
        receiver_id   UUID NOT NULL REFERENCES accounts(user_id),
        amount        BIGINT NOT NULL,
        currency      CHAR(3) NOT NULL,
        cose_proposal BYTEA NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('PENDING','SETTLED','FAILED_INSUFFICIENT','FAILED_EXPIRED')),
        synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE offline_intents;`);
};
