// Database-level append-only enforcement for the ledger's core tables
// (Ship List Phase 1 -- docs/THREAT_MODEL.md's "Tampering -- a compromised
// app credential mutating settled journal rows" row). A table's OWNER
// bypasses its own GRANTs, so this only works if the app connects as a
// role that is NOT the owner: this migration creates `tappay_app`, grants
// it normal CRUD everywhere (including on tables created by future
// migrations, via ALTER DEFAULT PRIVILEGES), then explicitly REVOKEs
// UPDATE/DELETE/TRUNCATE on journal and transfers specifically -- the two
// tables whose whole correctness argument (CLAUDE.md §5) depends on rows
// never changing once written. Migrations continue to run as the existing
// owner role (DATABASE_URL, unchanged); the app's own pool connects via
// APP_DATABASE_URL (config.ts's appDatabaseUrl), which falls back to
// DATABASE_URL until this migration has run, so nothing breaks mid-rollout.
//
// The proof artifact for this migration isn't the migration itself -- it's
// server/src/db/__tests__/appRolePrivileges.test.ts, which connects AS
// tappay_app and asserts an UPDATE actually fails with SQLSTATE 42501.
exports.shorthands = undefined;

const APP_ROLE = "tappay_app";
// Dev-only default, matching this repo's existing convention for
// placeholder secrets (.env.example's JWT_SECRET=dev-only-change-me) --
// APP_DB_PASSWORD must be set to a real value for any shared/deployed
// environment.
const APP_ROLE_PASSWORD = process.env.APP_DB_PASSWORD || "tappay_app_dev_password";

exports.up = (pgm) => {
  // Dollar-quoted so the password can contain a single quote without
  // breaking the surrounding SQL -- CREATE ROLE has no parameterized-query
  // form, so this is the correct way to embed an arbitrary string literal
  // here, not string-concatenation escaping.
  pgm.sql(`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', '${APP_ROLE}', $pw$${APP_ROLE_PASSWORD}$pw$);
      END IF;
    END
    $do$;
  `);

  pgm.sql(`
    GRANT CONNECT ON DATABASE tappay TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${APP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO ${APP_ROLE};

    -- The actual point of this migration: the app role can read and append
    -- to the ledger, but can never rewrite or erase a settled row.
    REVOKE UPDATE, DELETE, TRUNCATE ON journal, transfers FROM ${APP_ROLE};

    -- Defense-in-depth duplicate of db/kysely.ts's pool-level timeouts --
    -- these apply even to a connection that isn't this app's own pool (a
    -- raw psql session logged in as tappay_app, a forgotten one-off
    -- script), which the pool config alone can't cover.
    ALTER ROLE ${APP_ROLE} SET statement_timeout = '10s';
    ALTER ROLE ${APP_ROLE} SET lock_timeout = '3s';
    ALTER ROLE ${APP_ROLE} SET idle_in_transaction_session_timeout = '5s';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${APP_ROLE};
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${APP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM ${APP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${APP_ROLE};
    REVOKE CONNECT ON DATABASE tappay FROM ${APP_ROLE};
    REVOKE USAGE ON SCHEMA public FROM ${APP_ROLE};
    DROP ROLE IF EXISTS ${APP_ROLE};
  `);
};
