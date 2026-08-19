# Custom Semgrep rules

Five rules, each encoding a real invariant or a real incident this codebase
already hit once (see `docs/incidents/`). Run locally:

```bash
pip install semgrep==1.173.0   # or: docker run --rm -v "$PWD:/src" semgrep/semgrep:1.173.0 semgrep ...
semgrep --test semgrep/rules                                                       # rules vs. their own fixtures
semgrep --config semgrep/rules server/src packages/shared/src mobile/src mobile/app --exclude '**/__tests__/**' --error
```

`--error` is required for a nonzero exit on findings -- `semgrep --config`
alone always exits 0, findings or not. CI (`.github/workflows/ci.yml`'s
`security` job) runs both commands above.

| Rule | Encodes |
|---|---|
| `no-forupdate-outside-transaction` | A row lock taken outside an open transaction releases the instant the statement completes -- it never serializes anything. |
| `no-float-money` | CLAUDE.md §5: money is bigint minor units everywhere, no float round-trips. Suppress with `// nosemgrep: no-float-money` on the exact matched line for the one accepted exception (the metrics layer, `tripwire.ts` -- Prometheus has no bigint gauge type). |
| `lockaccount-without-ordering` | Two direct `lockAccount()` calls instead of `lockAccountsInOrder()` is the deadlock CLAUDE.md §5 / ADV-06 exist to rule out. |
| `client-supplied-identifier` | The recurring bug family CLAUDE.md §10 names explicitly: an `account_id`/`user_id` read from `request.body`/`params`/`query` instead of the JWT's `request.user.aid`/`.sub`. One accepted exception (`routes/tx.ts`, D2 -- genuinely unauthenticated, no `request.user` exists there). |
| `raw-error-to-response` | The reason `app.ts` has a centralized `setErrorHandler` at all: a raw Postgres constraint violation or a full zod dump reaching a client verbatim. |

## Fixture convention (verified, not assumed)

Each rule's test fixture is a file in `semgrep/rules/`, **same directory as
its `.yml`**, named `<rule-id>.ts`. A separate `semgrep/tests/` directory
does **not** work -- `semgrep --test` only discovers a fixture co-located
with its rule file. Found by direct reproduction (an earlier draft split
them into `rules/` and `tests/` and `semgrep --test` reported "No unit
tests found").

Inside a fixture, `// ruleid: <rule-id>` must sit on the line **directly
above** the statement expected to match (not above an enclosing function --
semgrep reports the match starting at the first line of the actual
statement). `// ok: <rule-id>` marks a case expected *not* to match.

`// nosemgrep: <rule-id>` (for real, accepted exceptions in application
code, not test fixtures) must be on the **same line** as the flagged code,
or the line **immediately** above it with nothing in between -- a multi-line
explanatory comment block before the suppressed line does not work; put the
explanation above and the `nosemgrep` marker as a trailing comment on the
matched line itself, as `routes/tx.ts` and `tripwire.ts` both do.
