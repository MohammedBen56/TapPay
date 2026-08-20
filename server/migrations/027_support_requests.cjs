// Ship List v2 Wave 2 Phase 6: in-app support / FAQ's contact-form half.
// A real, stored request (not just a mailto: link) -- gives a genuine
// audit trail and lets the caller see their own past requests
// (GET /support-requests), matching docs/INCIDENT_RESPONSE.md's
// single-owner-review reality: no admin reply flow yet, this is where a
// human operator would read them directly (or a future admin console),
// not a live-chat backend.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE support_requests (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(user_id),
        subject     TEXT NOT NULL,
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX idx_support_requests_user_id ON support_requests (user_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE support_requests;`);
};
