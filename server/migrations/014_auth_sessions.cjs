// Refresh-token storage for the v2 auth model (CLAUDE.md §4's v2 design doc):
// opaque tokens, stored as a SHA-256 hash only -- a DB leak never yields a
// usable token. Rotated on every /auth/refresh call; family_id ties a
// rotation chain together so presenting an already-rotated token (a theft
// signal) can revoke every token descended from the same original login in
// one update, not just the one row.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE auth_sessions (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL REFERENCES accounts(user_id),
        token_hash   BYTEA NOT NULL UNIQUE,
        family_id    UUID NOT NULL,
        issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at   TIMESTAMPTZ NOT NULL,
        revoked_at   TIMESTAMPTZ,
        replaced_by  UUID REFERENCES auth_sessions(id)
    );
  `);

  // Every refresh/logout lookup is by token_hash (already UNIQUE, so
  // single-row-fast); this index is for revoking a whole family in one
  // statement (`UPDATE ... WHERE family_id = $1 AND revoked_at IS NULL`) and
  // for pruning a user's stale sessions without a sequential scan.
  pgm.sql(`CREATE INDEX idx_auth_sessions_family ON auth_sessions (family_id) WHERE revoked_at IS NULL;`);
  pgm.sql(`CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE auth_sessions;`);
};
