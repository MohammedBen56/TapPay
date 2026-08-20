// Ship List v2 Wave 2 Phase 4: login-anomaly signal. Records a per-user
// fingerprint (see server/src/auth/deviceFingerprint.ts) on every
// successful login; a login from a fingerprint not already on this table
// gets flagged in audit_log as `login.new_device` -- a review-workflow
// signal, not an automatic block, matching docs/INCIDENT_RESPONSE.md's
// "single-owner, not a staffed rotation" reality.
//
// Deliberately mutable, unlike journal/transfers/audit_log/
// settlement_events -- last_seen_at is updated on every repeat login from
// an already-known fingerprint, so this table gets no REVOKE UPDATE.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE known_devices (
        user_id           UUID NOT NULL REFERENCES users(user_id),
        fingerprint_hash  BYTEA NOT NULL,
        first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, fingerprint_hash)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE known_devices;`);
};
