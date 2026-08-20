// Bill payments (electricity/water/internet) -- a mock biller catalog.
// Each biller is an ordinary `accounts` row (exactly like the mint account
// in 001_accounts.cjs is just an accounts row with is_mint=true): paying a
// bill is structurally a normal double-entry transfer to that row, so it
// automatically satisfies every existing ledger invariant and shows up for
// free in GET /accounts/me/transactions and GET /transfers/:txUuid (both
// already join accounts as the counterparty).
//
// Inserted directly here, not via server/scripts/seed.ts: seed.ts is the
// bank's CUSTOMER provisioning system (demo dev data, not run in CI --
// see .github/workflows/ci.yml), while billers are reference/catalog data
// every environment needs to exist right after `pnpm migrate`, the same
// reasoning that puts the mint account in a migration rather than a script.
//
// RIBs are real, valid mock RIBs (bank code 999, deliberately unassigned --
// same as every other RIB in this codebase) generated with this package's
// own packages/shared/src/rib.ts buildRib(), not hand-rolled math.
// Fictional brand names on purpose -- this is a mock bank; using real
// Moroccan utility names would misleadingly imply a real integration.
exports.shorthands = undefined;

const BILLERS = [
  {
    accountId: "00000000-0000-0000-0000-0000000000b1",
    email: "billing+atlas-power@tappay.local",
    name: "Atlas Power Co.",
    category: "electricity",
    rib: "999780000000000000200120",
  },
  {
    accountId: "00000000-0000-0000-0000-0000000000b2",
    email: "billing+northline-electric@tappay.local",
    name: "Northline Electric",
    category: "electricity",
    rib: "999780000000000000200217",
  },
  {
    accountId: "00000000-0000-0000-0000-0000000000b3",
    email: "billing+bluewell-water@tappay.local",
    name: "Bluewell Water Utilities",
    category: "water",
    rib: "999780000000000000200314",
  },
  {
    accountId: "00000000-0000-0000-0000-0000000000b4",
    email: "billing+clearline-water@tappay.local",
    name: "Clearline Water",
    category: "water",
    rib: "999780000000000000200411",
  },
  {
    accountId: "00000000-0000-0000-0000-0000000000b5",
    email: "billing+nexanet-broadband@tappay.local",
    name: "NexaNet Broadband",
    category: "internet",
    rib: "999780000000000000200508",
  },
  {
    accountId: "00000000-0000-0000-0000-0000000000b6",
    email: "billing+skyline-telecom@tappay.local",
    name: "Skyline Telecom",
    category: "internet",
    rib: "999780000000000000200605",
  },
];

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE billers (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id  UUID NOT NULL UNIQUE REFERENCES accounts(account_id),
        category    TEXT NOT NULL CHECK (category IN ('electricity', 'water', 'internet')),
        name        TEXT NOT NULL,
        is_active   BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`CREATE INDEX idx_billers_category ON billers (category) WHERE is_active;`);

  for (const b of BILLERS) {
    // account_id doubles as user_id, exactly like the mint account -- a
    // biller never logs in, so it needs no distinct user identity, just a
    // unique row satisfying accounts' NOT NULL/UNIQUE constraints.
    pgm.sql(`
      INSERT INTO accounts (account_id, user_id, email, currency, display_name, rib)
      VALUES ('${b.accountId}', '${b.accountId}', '${b.email}', 'MAD', '${b.name}', '${b.rib}');

      INSERT INTO billers (account_id, category, name)
      VALUES ('${b.accountId}', '${b.category}', '${b.name}');
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE billers;`);
  pgm.sql(`DELETE FROM accounts WHERE account_id IN (${BILLERS.map((b) => `'${b.accountId}'`).join(", ")});`);
};
