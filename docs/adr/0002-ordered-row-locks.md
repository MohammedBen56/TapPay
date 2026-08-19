# 0002 — Explicit ordered `SELECT ... FOR UPDATE`, not `SERIALIZABLE` isolation

## Context

Every balance-affecting operation (`reserve`, `commit`, `transfer`) touches
one or two `accounts` rows and must serialize against any other operation
touching the same row, or two concurrent transfers can both read the same
stale available balance and both succeed — an overdraft. `MockBankAdapter`
needs this to hold under real concurrent load, not just in a single-threaded
test.

## Decision

Every balance-affecting transaction acquires explicit row locks via
`SELECT ... FOR UPDATE` on the `accounts` table, in strict lexicographical
`account_id` order when two accounts are touched (`lockAccountsInOrder`,
`server/src/db/locking.ts`). Locking `journal` rows was an earlier draft and
was rejected — it only locks rows that already exist, so two concurrent
calls can both read the same available-balance snapshot before either insert
becomes visible, a phantom-read race that still allows overdraft.
`lockAccount`'s own doc comment carries this reasoning verbatim, since it's
the detail most likely to be "simplified away" by a future contributor who
doesn't know why the account row — not the journal row — is the
serialization point.

## Alternatives considered

- **Postgres `SERIALIZABLE` isolation, trusting the database to detect and
  abort conflicting transactions.** Rejected: `SERIALIZABLE` correctness has
  real, documented edge cases (Jepsen's analysis of PostgreSQL 12.3 found
  permitted anomalies under specific conditions), and even where it holds,
  it turns a lock-ordering bug into a retry-storm bug under load rather than
  eliminating the underlying race — the application still needs a retry
  policy, and now has two failure modes to reason about instead of one.
  Explicit ordered locks are provable by inspection (`[a, b].sort()`); a
  reliance on `SERIALIZABLE` is a reliance on the database's conflict
  detection being exhaustive, which is a stronger and less auditable claim.
- **An application-level distributed lock (Redis, an in-memory mutex).**
  Rejected: this is exactly the trap that breaks the moment the server runs
  as more than one instance. A lock that lives outside the transaction that
  needs it is not atomic with that transaction.

## Consequences

Deadlock avoidance depends entirely on every caller going through
`lockAccountsInOrder` rather than calling `lockAccount` twice in an
unordered pair — this is the one discipline every future balance-touching
code path must follow, and it's exactly what ADV-06 (100 concurrent
bidirectional transfers between the same two accounts) tests for. A static
rule flagging a second `lockAccount` call without going through
`lockAccountsInOrder` is planned (Ship List, Phase 3) as a mechanical
backstop.

## Revisit trigger

If the account table is ever partitioned or sharded such that two accounts
in one transfer can live on different physical shards, this entire locking
strategy needs to be redesigned — a cross-shard transfer cannot take a
single-database row lock at all. See the backend research's explicit
recommendation against sharding the ledger for that reason.
