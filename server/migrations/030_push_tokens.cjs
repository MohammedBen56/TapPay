// Ship List v2 Wave 2 Phase 8: push notifications. A user can have more
// than one registered device (token), hence a separate table keyed by
// (user_id, token) rather than a single column on `users` -- signing in
// on a second phone shouldn't silently stop notifications reaching the
// first one. See server/src/notifications.ts for the delivery function
// this backs.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE push_tokens (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(user_id),
        token       TEXT NOT NULL,
        platform    TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, token)
    );
  `);

  pgm.sql(`CREATE INDEX idx_push_tokens_user_id ON push_tokens (user_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE push_tokens;`);
};
