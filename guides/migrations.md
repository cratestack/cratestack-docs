---
title: Migrations
description: Forward-only migration runner with checksum drift detection and per-migration transaction semantics.
---

# Migrations

Banks ship database changes the same way they ship code: a reviewable SQL
diff, recorded in source control, applied once, never edited after the
fact. CrateStack's migration runner enforces that contract.

## Shape

A migration is a struct, not a file convention — banks integrate it into
whatever build tooling they already use:

```rust
use cratestack::Migration;

let migrations = vec![
    Migration {
        id: "20260101000000_create_accounts".to_owned(),
        description: "create accounts table".to_owned(),
        up: r#"
            CREATE TABLE accounts (
                id BIGINT PRIMARY KEY,
                balance NUMERIC NOT NULL DEFAULT 0,
                version BIGINT NOT NULL DEFAULT 0
            );
            CREATE INDEX accounts_balance_idx ON accounts (balance);
        "#.to_owned(),
        down: None,
    },
    Migration {
        id: "20260201000000_add_currency".to_owned(),
        description: "add currency to accounts".to_owned(),
        up: "ALTER TABLE accounts ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';".to_owned(),
        down: None,
    },
];
```

Conventions banks adopt:

1. `id` is sortable — `YYYYMMDDHHMMSS_<slug>` is canonical
2. `description` is short and human-readable
3. `up` is the SQL applied forward, sent as a single batch to Postgres and run inside one transaction
4. `down` is recorded but **never executed** by the runner — irreversible-by-default is the safe banking posture

## Running

```rust
use cratestack::{apply_pending, status, ensure_migrations_table};

ensure_migrations_table(&pool).await?;
let applied: Vec<String> = apply_pending(&pool, &migrations).await?;
```

The runner:

1. compares each input migration against `cratestack_migrations`
2. skips already-applied rows whose checksum matches
3. aborts with `CoolError::Internal` if an applied row's checksum has drifted
4. for each pending row: opens a transaction, sends the entire `up` script in
   one batch via `sqlx::raw_sql(&migration.up)`, inserts the record into
   `cratestack_migrations`, commits

A failure anywhere in the batch rolls the whole migration back. A multi-
statement script with a broken second statement leaves zero artefacts —
the first `CREATE TABLE` rolls back with the failed `CREATE INDEX`, and
`cratestack_migrations` does **not** record the partial attempt.

## Checksum drift

Each migration's checksum is `SHA-256(id || \0 || description || \0 || up)`.
Editing an already-applied migration in source control changes the
checksum:

```text
migration `20260101000000_create_accounts` is recorded as applied but its
SQL has changed; resolve drift before continuing
```

The runner refuses to apply anything until the drift is resolved. Banks
treat this as a release-process failure to escalate to humans — there is
no `--force` flag. Restoring the original SQL or rolling forward with a
new migration are the two acceptable resolutions.

## Inspecting state

`status(&pool, &migrations)` returns one `MigrationState` per input:

```rust
pub struct MigrationState {
    pub id: String,
    pub status: MigrationStatus,
}

pub enum MigrationStatus {
    Pending,
    Applied,
    ChecksumMismatch,
}
```

Banks plug this into a deployment dashboard so operators see drift before
the next deploy attempt.

## Multi-statement scripts

An earlier version of the runner split `up` on `;` client-side before
executing each statement. That approach broke on dollar-quoted PL/pgSQL
bodies, which routinely contain their own semicolons ([issue #270](https://github.com/cratestack/cratestack/issues/270)), so as of v0.6.0
the runner no longer parses or splits `up` at all: the entire script is
sent to Postgres in a single batch via `sqlx::raw_sql(&migration.up)`,
which uses the simple-query protocol and lets Postgres itself handle
statement boundaries — dollar-quoting included. Common patterns this
enables:

```sql
CREATE TABLE transfers (
    id BIGINT PRIMARY KEY,
    amount BIGINT NOT NULL,
    status TEXT NOT NULL
);
CREATE INDEX transfers_status_idx ON transfers (status);
INSERT INTO transfers_status_lookup (key, label)
    VALUES ('pending', 'Pending'), ('settled', 'Settled');
```

All three statements land atomically. A failure in the `INSERT` rolls the
`CREATE TABLE` and `CREATE INDEX` back together.

## What the runner is not

1. not a `down`/rollback engine — `down` is recorded for audit but never run
2. not a parallel-applier — migrations are sequential and serialized through the tracking table
3. not a long-running-migration coordinator — banks executing a 6-hour `ALTER TABLE` use their own backfill tooling and record the migration as a no-op when the backfill is done

## Generating migrations from `.cstack`

The runner consumes SQL migrations identically whether they are hand-written or generated. CrateStack ships a separate **schema diff generator** that produces those migrations from `.cstack` against a committed schema snapshot — see [ADR 0004](../internals/schema-diff-adr) for the full design.

Today, two subcommands are shipped:

* `cratestack migrate diff` — offline. Diffs the current `.cstack` against `migrations/<backend>/schema.snapshot.json` and writes a new migration directory.
* `cratestack migrate baseline` — adopts a database that already has tables and no prior `cratestack` migration history, by introspecting it directly instead of assuming an empty starting point. See [Adopting an Existing Database](../tooling/migrate-baseline) for a full walkthrough against a real database.

Two more are planned but **not yet implemented**, per the
["shipping order"](../internals/schema-diff-adr) list:

* `cratestack migrate verify` — deferred. Intended as a CI gate that replays the full migration history against an ephemeral DB and checks the result matches the snapshot; blocked on ephemeral-DB spawning support.
* `cratestack migrate drift` — deferred. Intended as a read-only ops tool reporting differences between the committed snapshot and a live database, without writing anything. Distinct from `migrate baseline` above, which introspects a live database too but only for the one-time act of adoption — it writes a new snapshot and a `cratestack_migrations` row, where `migrate drift` would only report.

Generated migrations remain reviewable SQL diffs — that property is preserved. The generator just removes the hand-translation step from `.cstack` to SQL. Destructive operations (column drop, lossy type change) still require explicit opt-in, and renames still require an explicit `@rename` annotation.

Hand-written migration steps coexist with generated ones via optional `up.pre.sql` / `up.post.sql` files inside the migration directory; the generator never overwrites them. Use these for backfills, lookup-table seeds, materialized-view refreshes, and any transform the diff engine cannot infer.

## Foreign keys, referential actions, and composite uniqueness

The generator emits real integrity constraints for two `.cstack` attributes, not just the columns behind them.

**`@relation` fields emit a `FOREIGN KEY` constraint.** The owning side of a relation (the side with `fields:`/`references:`, not the has-many `List` side) is projected into an `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (...) REFERENCES ...` statement, named `<table>_<column>_fkey` to match Postgres's own auto-generated name:

```cstack
model Application {
  id       String @id
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade, onUpdate: Restrict)
}
```

```sql
ALTER TABLE applications ADD CONSTRAINT applications_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE ON UPDATE RESTRICT;
```

`onDelete`/`onUpdate` accept `Cascade`, `Restrict`, `SetNull`, `SetDefault`, or `NoAction`. Both are optional and default to `NoAction` — Postgres's own default — which the generator omits from the DDL rather than spelling out. Two rules are enforced at `cratestack check` time, before they'd otherwise surface as a Postgres `ADD CONSTRAINT` failure with no `.cstack` context:

1. `onDelete`/`onUpdate` can only be declared on the relation's owning side — the `List`-typed "many" side has no physical column of its own to attach a constraint to.
2. `onDelete: SetNull` / `onUpdate: SetNull` requires the local foreign-key field to be optional (`tenantId String?`); `SetDefault` requires it to declare `@default(...)`.

**Model-level `@@unique([...])` emits a `CREATE UNIQUE INDEX`.** Field-level `@unique` already did this for a single column; `@@unique` extends the same `<table>_<col1>_<col2>_..._key` naming convention across every listed column, in declaration order:

```cstack
model Application {
  id          String @id
  tenantId    String
  name        String
  environment String

  @@unique([tenantId, name, environment])
}
```

```sql
CREATE UNIQUE INDEX applications_tenant_id_name_environment_key
  ON applications (tenant_id, name, environment);
```

This matters beyond integrity: Postgres only accepts `ON CONFLICT (a, b, c) DO UPDATE` when a unique index over exactly that column tuple exists, so upsert-based idempotency (see [Upsert](./upsert)) depends on this DDL actually being emitted.

**SQLite has no `ALTER TABLE ... ADD CONSTRAINT`.** The embedded backend can't retrofit a foreign key onto an existing table, so instead of silently producing no constraint, the generator emits a comment marking where the constraint would be, naming it explicitly so the gap is visible in the generated migration rather than invisible in the database.

Framework source of truth: [issue #260](https://github.com/cratestack/cratestack/issues/260) / [PR #261](https://github.com/cratestack/cratestack/pull/261) (foreign keys), [issue #262](https://github.com/cratestack/cratestack/issues/262) / [PR #266](https://github.com/cratestack/cratestack/pull/266) (`@@unique` indexes), and [PR #268](https://github.com/cratestack/cratestack/pull/268) (`onDelete`/`onUpdate`).

## Schema

```sql
CREATE TABLE cratestack_migrations (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    checksum BYTEA NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The DDL is exposed as `cratestack::MIGRATIONS_TABLE_DDL` and applied
idempotently by `ensure_migrations_table`.

## Read Next

1. [Adopting an Existing Database](../tooling/migrate-baseline) — `cratestack migrate baseline`, a full walkthrough of pointing this migration runner at a real, already-populated database for the first time
2. [ADR 0004: Schema diff and migration generation](../internals/schema-diff-adr) — how `.cstack` changes turn into the SQL this runner applies
3. [Schema diff (CLI)](../tooling/schema-diff) — `cratestack diff` checks the same two `.cstack` versions for wire-contract breaking changes, independent of the DB migration this page describes
4. [Composite keys](../reference/composite-keys) — `@@id([...])` / `@@unique([...])`, the multi-column constraints this generator emits
5. [Field attributes](../reference/field-attributes) — full `@relation`/`onDelete`/`onUpdate`/`@@unique` syntax reference
6. [Audit log](./audit-log) — banks frequently land `@@audit` retroactively via a migration
7. [Soft delete](./soft-delete) — `deleted_at` columns are typically added by a follow-up migration on existing models
