---
title: "ADR 0003: SQL Views as Projections of Models"
description: Read-only typed views built from .cstack model projections, with per-backend SQL bodies and a server-only materialized variant.
---

# ADR 0003: SQL Views as Projections of Models

## Status

Accepted

## Date

- Proposed: 2026-05-14
- Accepted: 2026-05-18

## Implementation

Shipped end-to-end across eight PRs on `cratestack/cratestack`:

| # | Slice |
| --- | --- |
| [#84](https://github.com/cratestack/cratestack/pull/84) | parser + IR + validator (`view <Name> from <Model>, …`, `@@server_sql`/`@@embedded_sql`/`@@sql`/`@@materialized`/`@@no_unique`, `@@allow("read", …)`) |
| [#85](https://github.com/cratestack/cratestack/pull/85) | `ReadSource` / `WriteSource` traits + `ViewDescriptor` in `cratestack-sql` |
| [#86](https://github.com/cratestack/cratestack/pull/86) | shared read helpers polymorphic over `ReadSource` (`push_scoped_conditions`, `authorize_record_action`, `render_select`, `render_select_by_pk`) |
| [#87](https://github.com/cratestack/cratestack/pull/87) | read builders generic over `ReadSource`; `ViewDelegate` + `ViewDelegateNoUnique` on both backends |
| [#88](https://github.com/cratestack/cratestack/pull/88) | macro emission — view struct, `<UPPER>_VIEW` descriptor const, `FromRow` impls, `runtime.views().<view_snake>()` accessor; embedded composer hard-errors on `@@materialized` |
| [#89](https://github.com/cratestack/cratestack/pull/89) | `cratestack-migrate` IR (`CreateView` / `ReplaceView` / `DropView` / `CreateMaterializedView` / `DropMaterializedView`) + diff + per-backend DDL + topological ordering against source tables and columns |
| [#90](https://github.com/cratestack/cratestack/pull/90) | `@@allow("read", …)` policy lowering — view attributes flow through the same model policy machinery via a synthesized `Model` |
| [#91](https://github.com/cratestack/cratestack/pull/91) | end-to-end integration tests against testcontainers Postgres (incl. `refresh()` round-trip) + in-memory SQLite |

Two notes on the shipped implementation that differ from the original proposal:

- **Body changes emit `Drop + Create`, not `CREATE OR REPLACE VIEW`.** Codex flagged that a `ReplaceView` op at the tail of the migration would leave the old view alive when the same migration also dropped a column the old body referenced (Postgres rejects the column drop in that case). The diff engine now models body changes as two ops — drop in the pre-column-drops bucket, create in the post-column-adds bucket — losing the atomicity of Postgres `CREATE OR REPLACE VIEW` but gaining ordering correctness when column ops overlap with view body changes. Within a Postgres migration transaction other connections never observe the transient missing-view state, so the atomicity loss has no externally visible effect. The `ReplaceView` IR variant is preserved for hand-constructed callers.
- **`@@no_unique` produces a separate `ViewDelegateNoUnique<V>` type** rather than just omitting `find_unique` from a single `ViewDelegate<V, PK>`. This enforces the gate at the type level — `runtime.views().<v>().find_unique(())` on a no-unique view is a compile error rather than a runtime "WHERE  = $1" footgun.
- **`refresh()` is an unconditional method on every view delegate**, not a method that is conditionally code-generated only for `@@materialized` views as this ADR's Decision section implies. In `crates/cratestack-sqlx/src/delegate/view.rs`, every `ViewDelegate` exposes `refresh()`; calling it on a non-materialized view is gated at **runtime** instead, returning `CoolError::Forbidden` rather than failing to compile.

## Context

CrateStack's primary developer surface is `.cstack` schema files that declare `model` blocks. Models map 1:1 to underlying SQL tables, get typed structs, and get a `ModelDelegate` with `find_many` / `find_unique` / `insert` / `update` / `delete`.

A recurring need is to expose **denormalized or computed read shapes** built from one or more models — account balances aggregated from transfers, customer summaries joining orders, dashboard panels filtered by status. Today these have to be hand-rolled outside the schema: raw `sqlx::query_as!`, manual struct definitions, manual policy enforcement. That loses every property CrateStack exists to provide: typed deserialization driven by schema, declarative authorization, generated clients, audit hooks.

The framework needs a first-class **view** concept that is a *projection of existing models* — read-only, SQL-defined, typed end-to-end, governed by the same `@@allow` policy machinery as models.

Three constraints shape the design:

1. **The macro split is strict** ([ADR 0001 0.3.0 update](./core-architecture-adr)) — server emit must reference sqlx only, embedded emit must reference rusqlite only, no cross-backend code.
2. **SQL dialect portability is a lie.** Postgres and SQLite agree on `CREATE VIEW … AS SELECT` syntax but diverge on aggregate casts, window function support, JSON functions, materialized views, and concurrent refresh. A single SQL string cannot drive both backends in general.
3. **Banking-grade auditability** ([banking readiness](../overview/banking-readiness)) — view definitions must be reviewable as SQL, materialization behavior must not silently degrade between environments.

## Decision

CrateStack will add a `view` block to `.cstack` that declares a read-only, SQL-defined projection over one or more existing `model` blocks. Views are emitted per-backend with explicitly distinct SQL bodies, and a server-only `@@materialized` variant is supported with manual refresh semantics.

### Schema surface

```cstack
view ActiveCustomer from Customer, Order {
  id           Int       @id  @from(Customer.id)
  email        String         @from(Customer.email)
  orderCount   Int
  lastOrderAt  DateTime?

  @@server_sql("""
    SELECT c.id, c.email,
           COUNT(o.id)::int AS order_count,
           MAX(o.created_at) AS last_order_at
    FROM   customer c
    LEFT JOIN "order" o ON o.customer_id = c.id
    WHERE  c.deleted_at IS NULL
    GROUP  BY c.id, c.email
  """)
  @@embedded_sql("""
    SELECT c.id, c.email,
           COUNT(o.id)  AS order_count,
           MAX(o.created_at) AS last_order_at
    FROM   customer c
    LEFT JOIN "order" o ON o.customer_id = c.id
    WHERE  c.deleted_at IS NULL
    GROUP  BY c.id, c.email
  """)

  @@allow("read", auth() != null)
}
```

**Rules:**

* `view <Name> from <Model>, <Model>, …` declares the source-model dependency list. It is **not parsed from the SQL** — it is declared explicitly so the parser can validate model names, build a migration ordering graph, and so LSP cross-references work without an SQL parser.
* Every field must either carry `@from(Model.field)` (to bind the column to its typed source) or be **computed**, in which case the user declares the Rust type and the macro trusts the SQL.
* `@id` is required on exactly one field. Views without a natural unique key opt out with `@@no_unique`, which drops `find_unique` from the generated delegate.
* `@@server_sql("…")` and `@@embedded_sql("…")` are the per-backend SQL bodies. At least one must be present. If only one is declared, the view is **backend-specific** — building the other target emits a clear error pointing at the missing attribute span.
* `@@sql("…")` is a shorthand that applies to both backends. The macro emits a `cargo` warning that single-string portability is the developer's responsibility.
* `@@allow` is supported, but only with action `"read"`. Any other action is a parse error.

### Delegate split

A new `ViewDelegate` is added to both `cratestack-sqlx` and `cratestack-rusqlite` with **read-only** methods:

```rust
pub struct ViewDelegate<'a, V: 'static, PK: 'static> { /* … */ }

impl<'a, V, PK> ViewDelegate<'a, V, PK> {
    pub fn find_many(&self) -> FindMany<'a, V, PK>;
    pub fn find_unique(&self, id: PK) -> FindUnique<'a, V, PK>;
}
```

Write methods (`insert`, `update`, `delete`) are **not present** on `ViewDelegate`. Read-only-ness is enforced at the type level, not by runtime check.

The existing `FindMany` / `FindUnique` query builders are reused via a shared `ReadSource` trait:

```rust
pub trait ReadSource {
    const NAME: &'static str;             // SQL identifier (table or view)
    const COLUMNS: &'static [&'static str];
    type Row: DeserializeOwned;
}
```

Both `Model` and `View` descriptors implement `ReadSource`. Only `Model` descriptors implement the additional `WriteSource` trait that powers `insert` / `update` / `delete`. Views literally cannot be passed to write builders.

### Materialized views

`@@materialized` is **server-only**. Building a schema that contains a `@@materialized` view with the embedded backend enabled is a **hard compile error**. The error span is emitted by `crates/cratestack-macros/src/include/embedded.rs` on the `schema_path` string-literal argument at the Rust `include_embedded_schema!(...)` call site — rustc points at the caller's source file (e.g. `src/main.rs`), never at a location inside the `.cstack` file itself:

```
error: view `AccountBalance` is `@@materialized` which is not supported on the
       embedded backend (SQLite has no materialized views). Either gate this
       view with a feature flag or split it into a server-only schema.
       See ADR-0003 (cratestack-docs `internals/views-adr.md`) for the rationale.
      --> src/main.rs:12:5
       |
    12 |     include_embedded_schema!("schema.cstack");
       |     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

No silent fallback to a regular view. The read latency and consistency contracts of a materialized view differ enough from a regular view that degrading behavior on one backend would be a footgun, especially for banking workloads.

**Materialization is opt-in and additional**, not a replacement. A `@@materialized` view still requires `@@server_sql`; the `@@materialized` attribute changes the DDL emitted (`CREATE MATERIALIZED VIEW` + `CREATE UNIQUE INDEX` on the `@id` column) and adds a `refresh()` method to the generated delegate.

**Refresh is manual.** No scheduler, no event-driven refresh, no time-based refresh in this ADR. The developer calls:

```rust
runtime.views().account_balance().refresh().await?;
```

This emits `REFRESH MATERIALIZED VIEW CONCURRENTLY <name>`. Concurrent refresh requires a unique index, which is why `@@materialized` + `@@no_unique` is a parse-time error: without a unique index, the only available refresh is a non-concurrent one that takes `ACCESS EXCLUSIVE` and blocks all readers for the duration of the rebuild. CrateStack will not generate that on the developer's behalf.

See the [Materialized views guide](../guides/materialized-views) for refresh trigger patterns the developer is expected to implement.

### Migration emission

The macro emits, alongside the model table DDL:

* `CREATE VIEW <name> AS <server_sql>` for sqlx builds
* `CREATE VIEW <name> AS <embedded_sql>` for rusqlite builds
* For `@@materialized`: `CREATE MATERIALIZED VIEW <name> AS <server_sql>` and `CREATE UNIQUE INDEX <name>_pkey ON <name> (<id_column>)`

View DDL is ordered after its source-model DDL via the `from M, N` dependency list. The diff engine described in [ADR 0004](./schema-diff-adr) treats views as their own IR ops (`CreateView`, `ReplaceView`, `CreateMaterializedView`).

## Consequences

### Positive

* Read-shape definitions live next to model definitions, governed by the same review process.
* `@@allow` policies apply uniformly to views — no parallel authorization story.
* Type safety end-to-end: declared columns match Rust struct fields, source-field references catch typos at parse time.
* Macro split stays disjoint — server emit never references rusqlite, embedded emit never references sqlx.
* Materialized views remain explicit and opt-in; their consistency contract is honest about the dialect divide.

### Negative

* Two SQL bodies for cross-backend views is more typing than a single string. The shorthand `@@sql("…")` exists for cases where the developer is genuinely confident, but it ships with a warning.
* The view's SQL body is not statically validated against the source models' columns. A typo in the SQL is a runtime error at view-creation time (CI verification — see [ADR 0004](./schema-diff-adr) — catches this before production).
* `@@materialized` schemas cannot be shared between embedded and server contexts unmodified. This is intentional, but it does fragment some otherwise-portable schemas.

### Deferred

* **Time-based refresh** (`@@materialized(refresh = "5m")`) — defer until CrateStack has a scheduler primitive. Spawning `tokio::task` from the macro is the wrong layer.
* **Event-driven refresh** — the existing `ModelEvent` stream could drive it, but "refresh on every write" is wrong (thrash) and "refresh on burst end" needs debouncing config the schema can't easily express. Defer until there's a real use case.
* **Materialized views on embedded via table+trigger emulation** — out of scope. The semantics are different enough that a unified surface would mislead developers.

## Read Next

1. [Views reference](../reference/views) — full attribute and syntax reference
2. [Materialized views guide](../guides/materialized-views) — refresh trigger patterns
3. [ADR 0004: Schema diff and migration generation](./schema-diff-adr) — how view changes flow through migrations
