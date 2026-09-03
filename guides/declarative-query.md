---
title: Declarative Query Blocks
description: Typed, parameterized, policy-checked raw SQL declared in `.cstack` — for the reads the generated builders cannot express.
---

# Declarative Query Blocks

A `query` block puts a parameterized raw-SQL read into the schema, where
the framework can check its parameters at compile time, decode its result
into a declared type, and attach a policy to it. It exists for the reads
the generated builders genuinely cannot express — two aggregates in one
round trip, a `FILTER (WHERE …)` clause, a `GROUP BY … HAVING`, a CTE.

Before this, those reads forced a direct `sqlx` dependency and a hand-written
`db.pool()` call, which gets none of the three guarantees above.

## Syntax

The header follows `procedure`'s exactly: a name, a parenthesized argument
list, and a declared result type. The SQL body is a `@@sql(...)` attribute.

```cstack
type LoyaltyFeeSummary {
  total     Int
  thisMonth Int
}

query loyaltyFeeSummary(userId: String, cutoff: DateTime): LoyaltyFeeSummary
  @@sql("""
    SELECT
      COALESCE(SUM(discount), 0)::bigint AS "total",
      COALESCE(SUM(discount) FILTER (WHERE created_at >= $2), 0)::bigint AS "thisMonth"
    FROM loyalty_fee_events
    WHERE user_id = $1
  """)
  @allow(auth() != null && auth().subjectId == userId)
```

Use `@@sql("SELECT …")` for a single line, or a `"""…"""` block for
several. Exactly one `@@sql` per query is allowed; zero is an error. There
is no per-backend split — `@@server_sql` and `@@embedded_sql` are both
rejected on a `query`, because a query is Postgres-only.

`@allow` and `@deny` are the only other attributes a query understands.

### Result arity

`: T` returns exactly one row (`fetch_one`; no rows surfaces as
`CratestackError::NotFound`). `: T[]` returns zero or more (`fetch_all`,
typed `Vec<T>`). `T?` is rejected at parse time — use `T` for one row or
`T[]` for zero or more.

### The result type must be a `type`

A `model` is not accepted. Handing back a `Model` would make a raw,
unfiltered read look like the policy-filtered model read it is not, so the
parser refuses it:

```text
query `widgetTotals` has an unknown result type: `Widget` is not a `type`
declaration; a query's result must be a `type` block, because a query's raw
SQL gets none of the soft-delete or row-policy filtering a model read does
```

### Column names are the declared field names, verbatim

The row decoder looks up each declared field name exactly as written. A
`type` field `thisMonth` decodes from a column named `thisMonth`, so your
SQL must write `AS "thisMonth"` — **quoted**, since Postgres folds
unquoted identifiers to lower case. There is no snake_case fallback.

## Parameters are checked when you build

Parameters are declared separately and bound **positionally**: `$1` is the
first declared parameter, `$2` the second. Nothing rewrites the SQL text —
values go through `.bind(...)` in declaration order, never interpolation.

A parse-time scan validates the `$N` references in the body against the
declared argument list, in both directions:

- referencing `$3` when only two parameters are declared is a compile error
  naming the query and the declared parameter count
- declaring a parameter that no `$N` references is *also* a compile error —
  that is the half of a `$2`-typed-as-`$3` typo a one-directional check
  would miss

For `include_server_schema!` this happens at macro-expansion time, so both
show up under `cargo check`, not against a running server.

### Supported parameter types

`String`, `Cuid`, `Int`, `Float`, `Boolean`, `DateTime`, `Uuid`, `Bytes` —
at required arity only. Optional (`T?`) and list (`T[]`) parameters are not
supported.

<Note>
  **`Decimal` is not a supported parameter type.** Its Rust type depends on
  the schema's [`decimal =` macro argument](../reference/scalars#the-decimal-macro-argument),
  and whether that type implements `sqlx::Encode` depends on the backend
  crate's feature set — a matrix that has to be pinned down first. A money
  *result column* is unaffected; only parameters are restricted. Widening
  the list later is additive.
</Note>

## Calling it

The generated handle grows a `queries()` sub-accessor, mirroring `views()`:

```rust
use cratestack::{CratestackContext, CratestackError};

cratestack::include_server_schema!("schema.cstack", db = Postgres);

pub async fn monthly_loyalty_fees(
    db: &cratestack_schema::Cratestack,
    ctx: &CratestackContext,
    user_id: String,
    cutoff: cratestack::chrono::DateTime<cratestack::chrono::Utc>,
) -> Result<cratestack_schema::LoyaltyFeeSummary, CratestackError> {
    db.queries()
        .loyalty_fee_summary(
            &cratestack_schema::queries::loyalty_fee_summary::Args {
                userId: user_id,
                cutoff,
            },
            ctx,
        )
        .await
}
```

The method name is the query name in `snake_case`; the `Args` **field**
names are the declared parameter names verbatim, so a `userId` parameter
stays `userId`.

Each query also emits a module under `cratestack_schema::queries::<name>`
carrying `Args`, `Output`, `NAME`, `SQL`, `ALLOW_POLICIES`,
`DENY_POLICIES`, and the `run` function the accessor forwards to. The
accessor is a forwarder, not a second entry point — `run` is where the
policy check lives, and there is no unchecked variant beside it.

## The policy is not optional

`@allow` / `@deny` are evaluated inside `run`, before any SQL executes,
against the query's own declared arguments and the request context. The
policy dialect is the procedure one, so it resolves argument names
directly.

**A query that declares no `@allow` at all denies everyone** — the same
deny-by-default rule models and procedures follow. A denied call returns
`CratestackError::Forbidden` without touching the database.

`auth().isSystem()` is now usable in a query policy **and** in a procedure
policy, not just in a model's `@@allow`. That is the reconciliation shape
these blocks exist for: a background job or cron reconciler with no request
behind it, running a read no HTTP caller should reach.

```cstack
query systemOnlyTotals(userId: String): LoyaltyFeeSummary
  @@sql("SELECT … FROM loyalty_fee_events WHERE user_id = $1")
  @allow(auth().isSystem())
```

## Limits

These are the properties worth knowing before you reach for a query. None
of them are bugs; each is a deliberate v1 boundary.

### It reads only, and Postgres enforces that

`run` executes the statement inside a Postgres `READ ONLY` transaction, so
`INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` and DDL are refused by the
engine with SQLSTATE `25006` — including when hidden inside a
data-modifying CTE such as `WITH ins AS (INSERT … RETURNING …) SELECT …`,
which is an ordinary `SELECT` as far as the driver is concerned.

This is enforcement, not a SQL-text check: no keyword blocklist decides it.

It matters because a write reaching the database this way would bypass
`@@audit` rows, the `@@emit` outbox, `@version` optimistic locking,
[soft delete](./soft-delete), `@@internal` suppression, and the target
model's own write `@@allow`. Use a `procedure` or a model write builder to
change data.

### The policy does not filter rows

`@allow` gates **whether the call is permitted**, not **which rows the SQL
matches**. Nothing injects a `deleted_at IS NULL` predicate or a row-level
policy filter into a query body the way the generated read path does. If
the query reads a soft-delete-enabled model's table, deleted rows count
toward its results unless your SQL says otherwise — you own every `WHERE`
and `FILTER` predicate here.

### It runs on its own pooled connection

A query's transaction is opened on a connection taken from the pool, which
is **not** the connection an enclosing `db.transaction(...)` is using. A
query called from inside that closure cannot see writes the closure has
made but not yet committed: it observes the pre-transaction state and, for
a single-row query, may return `NotFound` for a row the closure just wrote.
Read after the transaction commits.

<Warning>
  **On a small pool this is a stall, not just a stale read.** The query
  takes a *second* connection for its duration. With no free slot the
  acquire blocks for `acquire_timeout` and then fails with "pool timed out
  while waiting for an open connection" — a deadlock risk, not merely an
  isolation surprise. Composing a query with an enclosing transaction is
  not supported in v1, and would be contradictory anyway: the query's
  transaction is `READ ONLY` and the enclosing one is not.
</Warning>

### Postgres and server-only

A `query` block is rejected at compile time by both of the other entry
macros:

- `include_embedded_schema!` rejects it — a query is Postgres-only raw SQL,
  and there is no `@@embedded_sql` twin
- `include_server_schema!(..., db = None)` rejects it — that macro call
  configures no database, so a query has nothing to run against

Both diagnostics name every offending query in declaration order.

### No client surface

A query generates no REST route, no RPC op ID, and no Rust, Dart, or
TypeScript client stub. It is callable only as a Rust function from code
already running inside the server process. Expose one over the wire by
wrapping it in a `procedure`.

There is also no result-shape inference, no named placeholders, no
"unchecked" execution variant, and no query-builder or composable-filter
surface.

## Where this fits

The `query` block is one of four features whose only purpose is
non-request-scoped use, alongside `auth().isSystem()`, `db.transaction(...)`
and `@@internal("action")`. ADR 0018 (`docs/adr/0018-orm-posture.md` in the
framework repo) records the decision they add up to: **using CrateStack as
an ORM — as the data layer for code that is not serving an HTTP request —
is a supported posture, not an accident**, and the in-process call surface
(the generated `Cratestack` handle and its model/view/query accessors,
`db.transaction(...)`, `db.pool()`, each procedure module's
`authorize_with_db` / `invoke_with_db`, the `ProcedureRegistry` trait, and
each query block's generated `run`) carries the workspace's ordinary pre-1.0
compatibility commitment.

## Read Next

1. [Find many](./find-many) for the generated read builder a query is the escape valve from
2. [Views](../reference/views) for the other declared-SQL construct — compiled once into a database object, not parameterized per call
3. [Soft delete](./soft-delete) for the filter a query body does **not** get for free
