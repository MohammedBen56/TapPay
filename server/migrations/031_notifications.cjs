// Ship List v2 Wave 2 Phase 8: the in-app notification center's backing
// store -- written on every notify() call (server/src/notifications.ts)
// regardless of whether a push token exists or a real push delivery
// succeeds, so the feature is fully usable and demoable even without a
// live device registered for push (this repo has no EAS project id yet
// -- see notifications.ts's own header comment for the real boundary
// that blocks actual push delivery, not this table).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE notifications (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(user_id),
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        data        JSONB,
        read_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX idx_notifications_user_id_created_at ON notifications (user_id, created_at DESC);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE notifications;`);
};
