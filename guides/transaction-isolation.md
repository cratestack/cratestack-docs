---
title: Transaction Isolation
description: Explicit isolation levels and retry-on-serialization-failure semantics through `run_in_isolated_tx` and the `@isolation` procedure attribute.
---

# Transaction Isolation

Banking flows that read state and write back based on that state — money
movement, hold consumption, settlement — need stronger semantics than the
PostgreSQL default of `READ COMMITTED`. CrateStack exposes the two pieces
this requires: explicit per-transaction isolation levels and a retry
loop for serialization failures.

## `run_in_isolated_tx`

The helper wraps a closure in `BEGIN`, `SET TRANSACTION ISOLATION LEVEL ...`,
the closure body, and `COMMIT`:

```rust
use cratestack::{cool_error_from_sqlx, run_in_isolated_tx, TransactionIsolation, CoolError};

run_in_isolated_tx(
    &pool,
    TransactionIsolation::Serializable,
    |mut tx| async move {
        let (balance,): (i64,) = sqlx::query_as("SELECT balance FROM accounts WHERE id = $1")
            .bind(account_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(cool_error_from_sqlx)?;
        if balance < amount {
            return Err(CoolError::Validation("insufficient funds".to_owned()));
        }
        sqlx::query("UPDATE accounts SET balance = balance - $1 WHERE id = $2")
            .bind(amount)
            .bind(account_id)
            .execute(&mut *tx)
            .await
            .map_err(cool_error_from_sqlx)?;
        Ok(((), tx))
    },
)
.await?;
```

Use `cool_error_from_sqlx` rather than `|e| CoolError::Database(e.to_string())`
at sqlx call sites — it preserves the SQLSTATE code and constraint name on
the typed `CoolError::DatabaseTyped` variant, so unique-violation helpers
and similar predicates can compare typed fields instead of substring-matching
the stringified detail. A missing row (`sqlx::Error::RowNotFound`) is mapped
to `CoolError::NotFound` so the response is a 404 rather than a 500.

The closure receives the transaction and must return it back paired with
the body's result — the wrapper owns the commit so the retry loop can
control it.

## Supported isolation levels

```rust
pub enum TransactionIsolation {
    ReadCommitted,
    RepeatableRead,
    Serializable,
}
```

Banks running money-movement code path use `Serializable`. Lighter
"consistent snapshot" reads use `RepeatableRead`. The default level
(without the helper) remains PG's `READ COMMITTED`.

## Retry on serialization failure

Under `Serializable` (SSI), Postgres can refuse to commit a transaction
that participates in a read-write dependency cycle, raising SQLSTATE
`40001`. The same code is raised on deadlock detection (`40P01`). Both
are transient — the [PG docs are explicit](https://www.postgresql.org/docs/16/transaction-iso.html)
that the entire transaction must be retried.

The wrapper retries automatically:

1. up to `MAX_RETRIES_DEFAULT` (3) times via `run_in_isolated_tx`
2. up to a caller-chosen budget via `run_in_isolated_tx_with_retries(pool, level, retries, body)`
3. on errors raised from any statement inside the body
4. on errors raised from `tx.commit()` itself — SSI can defer the conflict to commit time (write-skew)

After exhausting retries the final error bubbles out. Banks running
heavily contended workloads tune the retry budget up; CAS-style fast-fail
flows tune it down to 1.

## Procedure-level opt-in

Procedures declare their required isolation level inline:

```cstack
procedure transferFunds(input: TransferInput): TransferResult
  @isolation("serializable")
  @allow(auth() != null)
```

Constraints enforced at parse time:

1. one `@isolation` attribute per procedure
2. the level argument is a quoted string: `"serializable"`, `"repeatable_read"`, or `"read_committed"`
3. case-insensitive; underscores tolerated

The macro records the requested level on the procedure's metadata. A
handler reads `ProcedureMetadata::isolation` and decides whether to wrap
its body in `run_in_isolated_tx`. Auto-wrapping the dispatcher is on the
roadmap; today the choice is explicit.

## Body must use the supplied transaction

Every statement in the body should run through `&mut *tx`. Statements
that escape to the pool will not see the snapshot the wrapper opened, and
won't roll back on retry. The closure signature pins this:

```rust
FnMut(Transaction<'static, Postgres>) -> impl Future<
    Output = Result<(T, Transaction<'static, Postgres>), CoolError>,
>
```

The transaction goes in, the value plus the same transaction comes out.
It's `FnMut`, not `Fn` — the retry loop calls the closure again on each
serialization-failure retry, so it must be callable more than once.

## When commit-time retry matters

Two scenarios surface 40001 from `tx.commit()` rather than from a
statement:

1. **Write-skew anomaly.** Two transactions read overlapping rows, write
   disjoint rows, and SSI detects the read-write dependency only at the
   commit boundary.
2. **Predicate-lock contention.** A long-running SELECT participates in
   conflicts that aren't visible until the transaction tries to land.

The retry loop catches both. Without commit-time retry, callers would
observe a transient 40001 despite the API advertising automatic retries.

## What this is not

1. not a replacement for application-level conflict handling — some
   business logic genuinely needs the user to re-confirm after a stale
   read; the retry loop is the safety net, not the policy
2. not a distributed transaction coordinator — PG isolation only applies
   inside one database
3. not free — `Serializable` adds locking overhead; benchmark before
   applying it to read-heavy procedures

## Read Next

1. [Optimistic locking](./optimistic-locking) — row-level version checks complement transaction-level isolation
2. [Idempotency](./idempotency) — duplicate-execution protection at the request boundary
