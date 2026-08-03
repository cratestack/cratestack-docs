---
title: Views
description: Reference for the `view` block — read-only SQL projections of one or more models, with per-backend SQL bodies and optional materialization.
---

# Views

A `view` declares a **read-only, SQL-defined projection** over one or more existing `model` blocks. Views generate a typed Rust struct, a `ViewDelegate` with `find_many` / `find_unique`, and `CREATE VIEW` DDL during migration generation.

For the rationale, see [ADR 0003](../internals/views-adr).

## Minimal example

```cstack
view ActiveCustomer from Customer, Order {
  id          Int       @id  @from(Customer.id)
  email       String         @from(Customer.email)
  orderCount  Int

  @@sql("""
    SELECT c.id, c.email, COUNT(o.id) AS order_count
    FROM   customer c
    LEFT JOIN "order" o ON o.customer_id = c.id
    GROUP  BY c.id, c.email
  """)

  @@allow("read", auth() != null)
}
```

## Block header

```
view <Name> from <Model>, <Model>, …
```

* `<Name>` — PascalCase. Becomes the Rust struct name unchanged (`ActiveCustomer`) and the SQL view identifier as snake-cased + naively pluralized (`active_customers`). The naive pluralizer appends `s` (or `es` when the name already ends in `s`), so non-English-plural names like `Summary` produce `summarys` — your hand-written DDL or SQL body needs to use that exact identifier.
* `from <Model>, …` — the **source-model dependency list**. Each name must resolve to an existing model; the parser rejects unknown ones. The list also orders view DDL after source-model DDL during [migration generation](../internals/schema-diff-adr).

The parser does **not** inspect the SQL body — it cannot detect a body that references a model missing from `from`, nor a `from` model the body doesn't use. Both are developer responsibilities. (CI's `verify` migration replay catches body errors at the database boundary before they ship.)

## Fields

Fields use the same syntax as model fields, plus two view-specific attributes.

### `@id` (required)

Exactly one field must carry `@id`. Required for `find_unique` and (when `@@materialized` is set) the unique index that backs concurrent refresh.

Views without a natural unique key opt out:

```cstack
view RevenueByDay from Order {
  day      Date
  revenue  Decimal

  @@no_unique
  @@sql("…")
}
```

`@@no_unique` makes the accessor return a separate `ViewDelegateNoUnique<'_, V>` instead of the standard `ViewDelegate<'_, V, PK>`. The no-unique delegate exposes only `find_many` — `find_unique` and `refresh()` are absent **at the type level**, so a call like `runtime.views().revenue_by_day().find_unique(())` is a compile error rather than a runtime "WHERE  = $1" footgun.

`@@no_unique` is **incompatible with `@@materialized`** (see below): concurrent refresh requires a unique index.

### `@from(Model.field)`

Documents that a view column is sourced from a typed field on one of the
`from` models — a hint for readers about provenance, not something the
parser checks today. `@from(...)` is parsed like any other unrecognized
`@...` field attribute: an opaque raw string. There is currently no
validation that `Model.field` exists, that the view column's Rust type
matches the source field's, or that column-level policies on the source
field propagate to the view. Treat it as documentation until that
validation lands.

`@from` is optional. Columns without it are **computed** — the developer declares the Rust type and the macro trusts the SQL.

```cstack
view ActiveCustomer from Customer, Order {
  id          Int       @id  @from(Customer.id)   // bound
  email       String         @from(Customer.email) // bound
  orderCount  Int                                  // computed
}
```

## SQL body attributes

A view must declare at least one of `@@server_sql`, `@@embedded_sql`, or `@@sql`.

### `@@server_sql("…")` and `@@embedded_sql("…")`

Per-backend SQL bodies. Required when the dialects diverge — Postgres aggregate casts (`COUNT(o.id)::int`), `DISTINCT ON`, JSON functions, window function variants, and many others are not portable to SQLite.

If only one is declared, the view is **backend-specific**. Building the other target with this view in scope is a clear compile error pointing at the missing attribute.

### `@@sql("…")`

Shorthand that applies to both backends. The macro emits a `cargo` warning that single-string portability is the developer's responsibility. Use only when the SQL body is genuinely a portable subset.

## `@@allow("read", …)`

Same authorization machinery as models, but **only the `"read"` action is supported**. Any other action (`"create"`, `"update"`, `"delete"`) is a parse-time error — views are not writable.

```cstack
@@allow("read", auth() != null)
@@allow("read", auth().role == "admin")
```

Multiple `@@allow("read", …)` rules combine with OR, same as on models.

**No `@@allow` means no rows visible.** Views inherit the same default-deny posture models have: a view with no `@@allow("read", …)` rule declared produces an implicit `WHERE FALSE` in every read query. This is intentional — it forces explicit authorisation rather than allowing accidental data exposure. Use `@@allow("read", auth() != null)` for a "any authenticated caller can read" stance.

## `@@materialized` (server-only)

Marks the view as a Postgres materialized view. Server-only — building this view with the embedded backend enabled is a **hard compile error** referencing [ADR 0003](../internals/views-adr). There is no silent fallback to a regular view.

```cstack
view AccountBalance from Account, Transfer {
  accountId Uuid     @id  @from(Account.id)
  balance   Decimal

  @@materialized
  @@server_sql("""
    SELECT a.id AS account_id,
           a.opening_balance
           + COALESCE(SUM(t.amount), 0) AS balance
    FROM   account a
    LEFT JOIN transfer t ON t.account_id = a.id
    GROUP  BY a.id, a.opening_balance
  """)

  @@allow("read", auth().id == accountId)
}
```

When `@@materialized` is set:

* Calling `refresh()` on this view's delegate succeeds, emitting `REFRESH MATERIALIZED VIEW CONCURRENTLY <name>`. `refresh()` itself is not conditionally generated — every `ViewDelegate` exposes `pub async fn refresh(&self) -> Result<(), CoolError>` unconditionally, and the check is a runtime one: it returns `CoolError::Forbidden` if the view isn't `@@materialized`. (The separate `ViewDelegateNoUnique` used by `@@no_unique` views omits `refresh()` at the type level, as noted above — but that's a distinct, unique-index-driven restriction, not how non-materialized-but-unique views are handled.)
* The migration emits `CREATE MATERIALIZED VIEW <name> …` plus `CREATE UNIQUE INDEX <name>_pkey ON <name> (<id_column>)` to back the concurrent refresh.
* `@@no_unique` is rejected: concurrent refresh requires a unique index, and CrateStack will not silently downgrade to a non-concurrent refresh that takes `ACCESS EXCLUSIVE`.

Refresh is **never automatic**. See the [Materialized views guide](../guides/materialized-views) for refresh trigger patterns.

## Generated surface

For a view named `ActiveCustomer` declared with the schema above, the macro emits (in `cratestack_schema::models`):

```rust
pub struct ActiveCustomer {
    pub id: i64,
    pub email: String,
    pub orderCount: i64,
}

pub const ACTIVE_CUSTOMER_VIEW: cratestack::ViewDescriptor<ActiveCustomer, i64> = /* … */;
```

Rust field names are kept verbatim from the schema (`orderCount`, not `order_count`); the row decoder looks columns up by their schema-side name via the macro-emitted `<sql_name> AS "<rust_name>"` aliases in `select_projection`. Scalar `Int` is `i64`.

On the runtime:

```rust
let cool = cratestack_schema::Cratestack::builder(pool).build();

// find_many — read-only iteration with filter / order / limit.
let rows = cool
    .views()
    .active_customer()      // ViewDelegate<'_, ActiveCustomer, i64>
    .find_many()
    .run(&ctx)              // CoolContext drives `@@allow` enforcement
    .await?;

// find_unique — single-row lookup by PK. Returns Option<ActiveCustomer>.
let one = cool.views().active_customer().find_unique(customer_id).run(&ctx).await?;
```

Views never expose `insert`, `update`, or `delete`. This is enforced **at the type level** — `ViewDescriptor` does not implement the `WriteSource` trait that powers write builders, so the bound on those builders simply fails to hold.

## Parse-time validation summary

| Rule | Failure mode |
| --- | --- |
| Exactly one `@id` field, or `@@no_unique` | Parse error |
| At least one of `@@server_sql` / `@@embedded_sql` / `@@sql` | Parse error |
| `@@allow` action is `"read"` | Parse error otherwise |
| `@@materialized` + `@@no_unique` | Parse error |
| `@@materialized` requires `@@server_sql` **or** `@@sql` (either satisfies it) | Parse error |
| `@@materialized` + embedded build target | Compile error referencing [ADR 0003](../internals/views-adr) |

`@from(M.f)` is **not** validated by the parser today — it's an opaque, unchecked attribute (see above). There is no parse-time check that `M.f` exists, that the model is in `from`, or that the field type matches.

## Read Next

1. [Materialized views guide](../guides/materialized-views) — when and how to call `refresh()`
2. [ADR 0003: SQL views as projections of models](../internals/views-adr) — design rationale
3. [Migrations](../guides/migrations) — how view DDL flows through the migration runner
