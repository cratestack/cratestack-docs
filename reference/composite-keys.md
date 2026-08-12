---
title: Composite Keys
description: Multi-column `@@id([...])` primary keys and `@@unique([...])` unique constraints — syntax, emitted DDL, and current codegen support.
---

# Composite Keys

Two model-level attributes take a bracketed, ordered list of local field
names instead of applying to a single field:

* `@@id([...])` — the model's primary key spans every listed column.
* `@@unique([...])` — a unique constraint spans every listed column. A
  model may declare several.

Both share the same syntax and the same field-name rules — at least two
fields, no repeats, every name must resolve to a real scalar field on the
model (not a relation, not a field carrying `@readonly` / `@server_only`
on `@@id`'s case) — but they differ in what they unlock today.

```cstack
model AccountMembership {
  accountId String
  subject   String
  active    Boolean

  @@id([accountId, subject])
}

model Application {
  id          String @id
  tenantId    String
  name        String
  environment String

  @@unique([tenantId, name, environment])
}
```

Column order is significant for both: it's the order columns appear in
the emitted constraint, and for `@@unique` it's also part of the
generated index name (`applications_tenant_id_name_environment_key`,
following the same `<table>_<column>_key` convention as field-level
`@unique`). Reordering the list is a real schema change — `cratestack
migrate diff` emits a drop-and-recreate, not a no-op.

## `@@id([...])` — composite primary key

`cratestack-migrate` emits a real multi-column `PRIMARY KEY` constraint
for it, and `cratestack check` validates the field list at authoring
time. Both backends are covered.

### Not usable in a running app yet

`include_server_schema!` and `include_embedded_schema!` reject any
model declaring `@@id([...])` with a compile error — query builders,
axum/RPC routing, and all three client generators (`cratestack-client-rust`
/ `-dart` / `-typescript`) still assume exactly one scalar `@id` column
throughout. A schema using `@@id([...])` today is authorable and
migratable, but not yet loadable by a server or embedded app. Track
[issue #136](https://github.com/cratestack/cratestack/issues/136) for
status.

## `@@unique([...])` — composite unique constraint

`cratestack-migrate` emits `CREATE UNIQUE INDEX <table>_<col1>_<col2>_key
ON <table> (<col1>, <col2>)` for each declared `@@unique([...])`, on both
Postgres and SQLite — the same DDL a hand-written unique index would
produce. `cratestack check` validates it the same way as `@@id([...])`.

Unlike `@@id`, this one compiles through codegen without complaint —
there's no ORM-level feature depending on it yet, so there's nothing to
reject.

### What it enables today

A real, enforced database constraint. This matters beyond integrity:
Postgres will only accept `INSERT ... ON CONFLICT (a, b, c) DO UPDATE`
when a unique index over exactly that tuple exists, so a hand-written
idempotent upsert targeting a composite key now has something to
conflict on.

```sql
INSERT INTO applications (id, tenant_id, name, environment, ...)
VALUES ($1, $2, $3, $4, ...)
ON CONFLICT (tenant_id, name, environment)
DO UPDATE SET ...;
```

### Upserting on a composite unique key

[`.upsert(...)`](../guides/upsert) defaults to conflict-targeting the
primary key, but it also accepts an explicit `ConflictTarget` so it can
target a `@@unique([...])` tuple instead — this shipped in v0.3.3
([issue #28](https://github.com/cratestack/cratestack/issues/28)), it is
not a future addition. Call `.on_conflict(...)` with
`ConflictTarget::Columns(&[...])`, naming exactly the columns behind the
unique index:

```rust
client
    .application()
    .upsert(input)
    .on_conflict(ConflictTarget::Columns(&["tenant_id", "name", "environment"]))
    .run(&ctx)
    .await?;
```

`ConflictTarget` is a two-variant enum —
`ConflictTarget::PrimaryKey` (the default) and
`ConflictTarget::Columns(&'static [&'static str])` — defined in
`cratestack-sql` and threaded through the `.on_conflict(...)` builder
method in `cratestack-sqlx`. The named columns must form a `UNIQUE`
constraint/index on the target table (exactly what `@@unique([...])`
emits), or Postgres will reject the `ON CONFLICT` clause at runtime. The
same builder method and `ConflictTarget` are available on the embedded
(rusqlite) path too, so this isn't a Postgres-only capability.

There's still no query-builder helper for "look up by this tuple" —
finding a row by its composite unique key is a hand-written `WHERE`
clause — but upserting on one is fully supported today.

## Read Next

1. [Migrations](../guides/migrations) — how `cratestack migrate diff`
   turns schema changes into the SQL these constraints compile to
2. [Field Attributes](./field-attributes) — the single-field `@id` /
   `@unique` these compose with
3. [Upsert](../guides/upsert) — `.on_conflict(...)` and composite-key
   conflict targets
