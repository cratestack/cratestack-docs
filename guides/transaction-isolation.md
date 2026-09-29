---
title: Transaction Isolation
description: Explicit isolation levels and retry-on-serialization-failure semantics through `run_in_isolated_tx`, and the `@isolation` procedure attribute (enforced since 0.14.1; ignored through 0.14.0).
---

# Transaction Isolation

Banking flows that read state and write back based on that state — money
movement, hold consumption, settlement — need stronger semantics than the
PostgreSQL default of `READ COMMITTED`. CrateStack exposes the two pieces
this requires: explicit per-transaction isolation levels and a retry
loop for serialization failures. `run_in_isolated_tx` is the hand-rolled
form for code that owns a pool, and works in every release. The
[`@isolation`](#procedure-level-isolation) procedure attribute does the
same from the schema since 0.14.1: through 0.14.0 it
is ignored.

## `run_in_isolated_tx`

The helper wraps a closure in `BEGIN`, `SET TRANSACTION ISOLATION LEVEL ...`,
the closure body, and `COMMIT`:

```rust
use cratestack::{cratestack_error_from_sqlx, run_in_isolated_tx, TransactionIsolation, CratestackError};

run_in_isolated_tx(
    &pool,
    TransactionIsolation::Serializable,
    |mut tx| async move {
        let (balance,): (i64,) = sqlx::query_as("SELECT balance FROM accounts WHERE id = $1")
            .bind(account_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(cratestack_error_from_sqlx)?;
        if balance < amount {
            return Err(CratestackError::Validation("insufficient funds".to_owned()));
        }
        sqlx::query("UPDATE accounts SET balance = balance - $1 WHERE id = $2")
            .bind(amount)
            .bind(account_id)
            .execute(&mut *tx)
            .await
            .map_err(cratestack_error_from_sqlx)?;
        Ok(((), tx))
    },
)
.await?;
```

Use `cratestack_error_from_sqlx` rather than `|e| CratestackError::Database(e.to_string())`
at sqlx call sites — it preserves the SQLSTATE code and constraint name on
the typed `CratestackError::DatabaseTyped` variant, so unique-violation helpers
and similar predicates can compare typed fields instead of substring-matching
the stringified detail. A missing row (`sqlx::Error::RowNotFound`) is mapped
to `CratestackError::NotFound` so the response is a 404 rather than a 500.

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
`40001`. Deadlock detection raises `40P01`. Both are transient: the
[PG docs are explicit](https://www.postgresql.org/docs/16/transaction-iso.html)
that the entire transaction must be retried.

The wrapper retries automatically:

1. up to 3 times via `run_in_isolated_tx`
2. up to a caller-chosen budget via `run_in_isolated_tx_with_retries(pool, level, retries, body)`
3. when a statement inside the body fails with `40001` or `40P01`
4. when `tx.commit()` itself fails with one of them: SSI can defer the conflict to commit time (write-skew)

Since 0.14.1, every other error is returned on the first attempt; in 0.14.0 and
earlier the helper also retried errors whose *text* looked like one of these (see below). After exhausting
retries, the last error is returned as is. For a `40001` mapped with
`cratestack_error_from_sqlx` that is a `DatabaseTyped` error, which a
handler answers as 500 `DATABASE_ERROR`, not the `409 TRANSACTION_ABORTED`
that [`@isolation`](#procedure-level-isolation) answers with. Banks running
heavily contended workloads tune the retry budget up; CAS-style
fast-fail flows tune it down to 1.

**Only database errors are retried** *(since 0.14.1)*. A typed
database error (`DatabaseTyped`, as `cratestack_error_from_sqlx` builds
it) is retried if and only if its SQLSTATE is `40001` or `40P01`; its
message is never read. Only the untyped `CratestackError::Database(String)`,
which has no SQLSTATE, is still classified by its text. In 0.14.0 and
earlier the helper also retried any error, `Validation` and `Internal`
included, whose text contained `40001`, `40P01`, `could not serialize
access` or `deadlock detected`. A body that echoed request data into its
own error (`field 'memo' length 40001 exceeds maximum 100`, or a
`RAISE EXCEPTION` with the requested amount) therefore ran again, with
anything it did outside the transaction, and the caller got the last
attempt's error instead of the first. This changes code that never uses
`@isolation`.

## Body must use the supplied transaction

Every statement in the body should run through `&mut *tx`. Statements
that escape to the pool will not see the snapshot the wrapper opened, and
won't roll back on retry. The closure signature pins this:

```rust
FnMut(Transaction<'static, Postgres>) -> impl Future<
    Output = Result<(T, Transaction<'static, Postgres>), CratestackError>,
>
```

The transaction goes in, the value plus the same transaction comes out.
It's `FnMut`, not `Fn` — the retry loop calls the closure again on each
serialization-failure retry, so it must be callable more than once.

*(Unreleased, [cratestack#1117](https://github.com/cratestack/cratestack/issues/1117).)* The
framework's own reads for a write the body makes through `run_in_tx(&mut tx, ctx)` (create policies
with their relation lookups, the `@version` probe, the upsert update-policy check, the `@@audit`
bootstrap) run on that same transaction. They see the body's earlier writes, read its snapshot under
`REPEATABLE READ` and `SERIALIZABLE`, and take no second pooled connection. Through 0.14.2 only an
`@isolation` procedure read them on its transaction; every other caller read them on the pool.

## When commit-time retry matters

Two scenarios surface 40001 from `tx.commit()` rather than from a
statement:

1. **Write-skew anomaly.** Two transactions read overlapping rows, write
   disjoint rows, and SSI detects the read-write dependency only at the
   commit boundary.
2. **Predicate-lock contention.** A long-running SELECT participates in
   conflicts that aren't visible until the transaction tries to land.

The retry loop catches both, in `run_in_isolated_tx` and (since 0.14.1) in `@isolation`
dispatch. Without commit-time retry, callers would observe a transient
40001 despite the API advertising automatic retries.

## Procedure-level isolation

<Warning>
**Since 0.14.1.** Enforcement of `@isolation` shipped in 0.14.1
([GHSA-r67q-4qqq-g9gm](https://github.com/cratestack/cratestack/blob/main/CHANGELOG.md),
see the `## 0.14.1` section of the framework CHANGELOG). **In every release from 0.2.0 through
0.14.0 the attribute is validated and then ignored:** the procedure runs on the pool at the server
default, normally `READ COMMITTED`, on REST, RPC (including `/rpc/batch`) and MCP. Two concurrent
declared-serializable withdrawals of 100 from a balance of 100 both succeeded. Earlier versions of
this page said a macro recorded the level for the handler to read; no such metadata ever existed.
On 0.14.0 and earlier, wrap the body yourself in `run_in_isolated_tx(db.pool(), ..)` and run its
SQL, and the write builders' `run_in_tx(&mut tx, ctx)`, through that transaction.
</Warning>

Procedures declare their required isolation level inline:

```cstack
mutation procedure transferFunds(input: TransferInput): TransferResult
  @isolation("serializable")
  @allow(auth() != null)
```

Constraints enforced at parse time:

1. one `@isolation` attribute per procedure
2. the level argument is a quoted string: `"serializable"`, `"repeatable_read"`, or `"read_committed"`
   (case-insensitive; `"repeatable read"` with a space is accepted too)
3. *(since 0.14.1)* not on a `@stream` procedure: a streamed response is produced after the
   procedure returns, so there is no point at which to commit, and a partly sent stream cannot be
   retried
4. *(since 0.14.1)* not in a `datasource { provider = "none" }` schema; and
   `include_server_schema!(.., db = None)` refuses it with a compile error

The embedded role generates no procedures, and the client role only calls them, so neither is
affected.

### What the attribute does

A procedure that declares `@isolation(level)` runs, on every path that can execute it, inside one
transaction begun with `BEGIN ISOLATION LEVEL <level>`: REST (`/$procs/<name>`), RPC
(`/rpc/procedure.<name>`), `/rpc/batch`, MCP `tools/call`, and the generated
`<procedure>::invoke_with_db`. Inside that transaction run:

1. its authorization: `@allow` / `@deny` and any `@authorize(...)` check
2. its body
3. the policy checks of every write it makes (create policies with their relation lookups, the
   `@version` probe, upsert update-policy checks)
4. the [`@computed`](./computed-fields) fields of its output

On SQLSTATE `40001` or `40P01`, from a statement or from `COMMIT`, the attempt is rolled back and
run again from authorization onwards. The budget is 3 retries (4 attempts), with a short jittered
backoff between them, and no transaction is held while waiting. Change it per runtime:

```rust
let db = cratestack_schema::Cratestack::builder(pool)
    .with_isolation_max_retries(5) // 0 disables retry
    .build();
```

An attempt in which any operation saw a retriable error is retried even if the body caught that
error and returned `Ok`. The same classifier as the helper applies: only database errors are
retried, and a typed SQLSTATE is authoritative, so an application error or a `RAISE EXCEPTION`
whose message contains `40001` is returned once, as itself.

### The handle: `IsolatedCratestack`

The `ProcedureRegistry` method of an `@isolation` procedure takes
`db: &cratestack_schema::IsolatedCratestack` instead of `&Cratestack`. Every operation reachable
from it runs inside the procedure's transaction:

| Method | Behaviour |
| --- | --- |
| model accessors (`db.account()` …) | the usual delegates; each operation runs in a savepoint of the transaction, so a caught failure (a unique violation, say) does not abort the whole transaction |
| `bind_context` / `bind_auth` | the usual bound handle, over the same transaction |
| `transaction(async \|tx\| ..)` | a savepoint inside the transaction; `tx` is the raw-SQL door (`&mut ***tx`), and `run_in_tx(tx, ctx)` works inside it |
| `dispatch_audit_sink(events)` | queued, and dispatched once after the transaction commits |

It has no `pool()`, `events()`, `views()` or `queries()`: those run on the pool, so their absence
is a compile error rather than a silent escape from the transaction. Operations on the handle run
one at a time: a concurrent call (`tokio::join!` of two operations) or a re-entrant one (a
`.run(ctx)` inside `db.transaction(..)`, where `tx` already holds the connection) fails with
`INTERNAL_ERROR` instead of deadlocking. Inside `db.transaction`, use `run_in_tx(tx, ctx)`.

For this schema fragment (alongside your `datasource` and `auth` blocks):

```cstack
model Account {
  id Int @id
  balance Int

  @@allow("read", auth() != null)
  @@allow("update", auth() != null)
}

type Withdrawal {
  accountId Int
  amount Int
}

type Receipt {
  before Int
  after Int
}

mutation procedure withdraw(args: Withdrawal): Receipt
  @isolation("serializable")
  @allow(auth() != null)
```

the read, the check and the debit below form one `SERIALIZABLE` transaction, so two concurrent
withdrawals cannot both pass the balance check:

```rust
use cratestack_schema::procedures as p;

impl p::ProcedureRegistry for Procedures {
    async fn withdraw(
        &self,
        db: &cratestack_schema::IsolatedCratestack,
        ctx: &CratestackContext,
        args: p::withdraw::Args,
        _authorized: p::withdraw::Authorized,
    ) -> Result<p::withdraw::Output, CratestackError> {
        let id = args.args.accountId;
        let amount = args.args.amount;
        let account = db
            .account()
            .find_unique(id)
            .run(ctx)
            .await?
            .ok_or_else(|| CratestackError::NotFound("no account".into()))?;
        if account.balance < amount {
            return Err(CratestackError::Validation("insufficient funds".into()));
        }
        let updated = db
            .account()
            .update(id)
            .set(cratestack_schema::UpdateAccountInput {
                balance: Some(account.balance - amount),
            })
            .run(ctx)
            .await?;
        Ok(cratestack_schema::Receipt {
            before: account.balance,
            after: updated.balance,
        })
    }
}
```

A raw-SQL `db.transaction(..)` that leaves the transaction aborted (a failed statement whose error
the closure does not return) or ends it, or that is cancelled or panics before it finishes, fails
the whole attempt with `INTERNAL_ERROR` even if the body then returns `Ok`. Never issue `COMMIT`,
`ROLLBACK` or `END` through `tx`: what ran before a raw `COMMIT` stays committed, and if the same
attempt had also swallowed a serialization failure it is retried rather than failed, so that
work is committed again.

### Retries exhausted

When the retries run out, the response is **`409` with code `TRANSACTION_ABORTED`** (RPC code
`aborted`), and the fixed message `transaction could not be completed because of concurrent
updates; retry the request`. It is not `CONFLICT`: nothing was committed, and sending the same
request again is expected to succeed. `CratestackError::TransactionAborted` is the new error
variant. Every generated client knows the code: the TypeScript and Dart RPC runtimes list it, the
Rust client maps a batch frame's `aborted` to 409, and so does `@cratestack/link-batch`.

**The idempotency key is released.** `IdempotencyLayer` (REST and RPC) and MCP's idempotency
admission do not record this response: the reservation is released so the same `Idempotency-Key`
runs the call again. Every other response, errors included, is recorded as before.

**Only the procedure whose own retries ran out answers `TRANSACTION_ABORTED`.** An abort that
reaches a response any other way is answered as `500 INTERNAL_ERROR` (RPC `internal`), recorded
under the key, with the original SQLSTATE in the operator's log. That covers a procedure, with or
without `@isolation`, that calls another one and propagates its abort, a `@computed` resolver that
does, and a hand-written handler that returns the error of an `@isolation` procedure's
`invoke_with_db`. Such a caller may have committed work of its own before the abort, so telling
its client "nothing was committed, retry" could apply that work twice. Serve the procedure through
the generated router, or map the error yourself, to answer it as retryable.

### Side effects and retries

| Effect | On a retried or failed attempt |
| --- | --- |
| model writes, `@@audit` rows, `@@emit` outbox rows | rolled back with the attempt |
| `AuditSink` fan-out, outbox drain | deferred; performed once, after the attempt that commits |
| `@computed` output fields | resolved again with the attempt; a resolver error fails it |
| idempotency reservation, rate-limit admission | once per request; retries are invisible to them |
| anything the body does outside the database (HTTP calls, e-mail, a counter in `self`) | **repeated** |

The body, and the `@computed` resolvers of its output, must be safe to run more than once. Make
external effects idempotent or move them behind `@@emit`.

Resolvers of an `@isolation` procedure's output receive the same `&Cratestack` argument as before,
but bound to the attempt: their model reads see the body's writes. Their `pool()`, `views()`,
`queries()` and `events()` still run on the pool, outside the snapshot.

An `@isolation` procedure invoked from inside another's attempt (a resolver can do this with the
attempt-bound `&Cratestack` it receives) **joins** that transaction as a savepoint: it commits
nothing on its own and is not retried separately, since the outermost attempt owns the retries. It
is refused if it declares a stricter level than the attempt it would join. Joined calls run one at
a time; starting a second one while another is still running, or cancelling one half-way, fails
the whole attempt.

`@isolation` does not make an RPC batch atomic: each `/rpc/batch` frame is its own transaction, as
it was before.

### Upgrading

1. Find the procedures that declare it: `grep -rn '@isolation'` over your `.cstack` files.
2. Review each body, and the `@computed` resolvers of its output, for effects that must not repeat.
3. Change `db: &Cratestack` to `db: &IsolatedCratestack` in those methods. Replace `db.pool()`
   with `db.transaction(..)`, and remove any hand-written `run_in_isolated_tx(db.pool(), ..)`
   wrapper: the dispatch provides it now.
4. A hand-written caller of `<procedure>::invoke_with_db` passes
   `FnOnce(IsolatedCratestack, Authorized) -> Fut + Clone` instead of `FnOnce(Authorized) -> Fut`;
   it is called once per attempt.
5. Treat `409 TRANSACTION_ABORTED` (RPC `aborted`) as retryable, with the same `Idempotency-Key`.
   `409 CONFLICT` keeps its meaning.
6. Size the pool: each in-flight call holds one connection for its whole transaction.

Two further changes reach code without `@isolation`: the helper's retry classifier (above), and a
Postgres error from the framework's own reads (`find_unique`, `find_many`, projections,
aggregates), the `@authorize` probe, create-policy relation lookups and `@@audit` writes is now the
typed `DatabaseTyped` rather than `Database`, with the same code, status and message. Code that
matched `Database(_)` for those errors must also match `DatabaseTyped(_)`, or use `code()` /
`db_sqlstate()`.

The full design, including what stays outside the guarantee, is
[`docs/design/procedure-isolation.md`](https://github.com/cratestack/cratestack/blob/main/docs/design/procedure-isolation.md).

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
