// Ship List v2 Wave 2 Phase 5: financial goals/vaults. Deliberately NOT a
// sub-account of savings -- earmarks an amount inside the customer's ONE
// savings account rather than giving each goal its own ledger account (a
// sub-account per goal would mean extending accounts.account_type's enum
// and its UNIQUE (user_id, account_type) constraint for real schema
// churn, to build what's fundamentally a display/tracking feature over
// money already safely in savings). Progress is a read query against
// saved_amount vs. the real savings balance; funding a goal increments
// saved_amount only -- no separate money movement, since the money
// already sits in savings (server/src/routes/goals.ts).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE goals (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id  UUID NOT NULL REFERENCES users(user_id),
        name           TEXT NOT NULL,
        target_amount  BIGINT NOT NULL CHECK (target_amount > 0),
        saved_amount   BIGINT NOT NULL DEFAULT 0 CHECK (saved_amount >= 0),
        target_date    DATE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX idx_goals_owner_user_id ON goals (owner_user_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE goals;`);
};
