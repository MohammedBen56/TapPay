// Ship List v2 -- a request-level audit trail, separate from and
// additional to the ledger's own append-only audit trail (journal/
// transfers, which record WHAT MONEY MOVED). This records WHO DID WHAT,
// WHEN -- "who accessed customer X's data, and when" is a standard
// compliance question this codebase could not answer before this
// migration (server/src/logging.ts's allow-list request logger
// deliberately excludes account_id/user_id from every log line to keep
// PII out of logs -- the same design that makes leakage risk near-zero is
// exactly why there was no audit trail; this table is the intentional,
// narrowly-scoped answer to that gap, not a blanket request logger, which
// would reintroduce the PII-leakage risk the logging design correctly
// avoids).
//
// user_id is nullable: a failed login against an unknown customer_id has
// no resolvable actor to attribute the attempt to, and that attempt is
// itself exactly the kind of event a security-relevant audit log should
// still capture.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE audit_log (
        id             BIGSERIAL PRIMARY KEY,
        user_id        UUID REFERENCES accounts(user_id),
        action         TEXT NOT NULL,
        resource_type  TEXT,
        resource_id    TEXT,
        ip             TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX idx_audit_log_user ON audit_log (user_id, created_at);`);
  pgm.sql(`CREATE INDEX idx_audit_log_action ON audit_log (action, created_at);`);

  // Append-only, same reasoning and same mechanism as transfers/
  // bill_payments (017_app_role.cjs) -- an audit trail that could be
  // edited or deleted by the very credential it's supposed to be
  // watching is not an audit trail.
  pgm.sql(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM tappay_app;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE audit_log;`);
};
