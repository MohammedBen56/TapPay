exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE devices (
        device_id        BYTEA PRIMARY KEY,          -- 16-byte UUID
        user_id          UUID NOT NULL REFERENCES accounts(user_id),
        identity_pubkey  BYTEA NOT NULL,              -- 33-byte compressed P-256
        platform         TEXT NOT NULL CHECK (platform IN ('android','ios')),
        attestation_blob JSONB NOT NULL,              -- verified at enrollment, spec §2.5
        attestation_ok   BOOLEAN NOT NULL DEFAULT false,
        last_seq         BIGINT NOT NULL DEFAULT 0,   -- anti-rollback monotonic tracker (M2)
        enrolled_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE devices;`);
};
