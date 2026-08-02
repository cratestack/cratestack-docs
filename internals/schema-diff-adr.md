---
title: "ADR 0004: Schema Diff and Migration Generation"
description: State-based migration generation from .cstack vs a committed schema snapshot, with CI verification and live-DB drift detection as separate concerns.
---

# ADR 0004: Schema Diff and Migration Generation

## Status

Proposed

## Date

2026-05-14

## Context

CrateStack's [migration runner](../guides/migrations) is a forward-only, checksum-verified applier of SQL migrations. The original position was that migrations are **hand-written**, because banks require reviewable SQL diffs and the runner is deliberately not a generator.

That position is correct for the *runner* and stays. But it left a gap on the *authoring* side: developers were left to translate `.cstack` schema changes into SQL by eye, every time, across two SQL dialects (Postgres for sqlx targets, SQLite for rusqlite targets). This is exactly the kind of manual translation that produces drift, missed `NOT NULL` constraints, and copy-paste errors — and it scales poorly as the schema grows. It is also the precise opposite of CrateStack's "schema is the source of truth" stance for models, types, procedures, and (per [ADR 0003](./views-adr)) views.

The framework needs a **schema diff and migration generation** capability that:

1. Treats `.cstack` as the source of truth and generates SQL migrations as a derived artifact.
2. Produces SQL that remains reviewable, commitable, and editable before merge.
3. Distinguishes generation (offline, deterministic) from verification (against a real DB) from drift detection (against live production).
4. Honors the strict per-backend macro split — separate migration trees for sqlx and rusqlite targets.
5. Refuses to silently perform destructive or lossy operations.

## Decision

CrateStack will add a **state-based migration generator** that diffs `.cstack` against a committed schema snapshot and emits per-backend SQL migrations. The runner is unchanged — it consumes generated migrations identically to hand-written ones, with the same forward-only, checksum-protected semantics.

This ADR supersedes the "not a schema-diff generator" claim in the [Migrations guide](../guides/migrations). The generator is a **developer tool**; the runner remains hand-written-friendly and the generated SQL remains reviewable before commit.

### State-based, not migration-based

`.cstack` is the source of truth. Migrations are derived. The diff input is:

* **Desired schema** — parsed from the current `.cstack` files.
* **Current schema** — read from a committed `schema.snapshot.json` reflecting the schema state after the last generated migration.

This is offline and deterministic. No database connection is required to generate a migration. The snapshot is just `serde_json` over the existing `cratestack_core::Schema` AST, committed alongside the migration files.

### Three separate commands

| Command | Purpose | Inputs | Side effects |
| --- | --- | --- | --- |
| `cratestack migrate diff` | Generate a new migration | `.cstack` + committed snapshot | Writes new migration directory + updates snapshot |
| `cratestack migrate verify` | Confirm migrations replay to the snapshot | All migrations + snapshot | Spawns ephemeral DB; read-only |
| `cratestack migrate drift` | Report differences from a live DB | Live DB + snapshot | Read-only against the live DB |

These are deliberately separate. `diff` is what the developer runs locally. `verify` is the CI gate — it replays the full migration history against an ephemeral Postgres/SQLite container and checks the resulting schema matches the snapshot byte-for-byte, catching hand-edited snapshots and hand-edited applied migrations. `drift` is the ops tool for "did someone hotfix production?" — it never writes anything and never generates a migration from live state, because conflating live drift with intended schema change is how silent corruption happens.

### Per-backend layout

```
migrations/
  postgres/
    20260514_120000_initial/
      up.sql
      down.sql            ← present when generation is non-lossy
      up.pre.sql          ← optional, hand-written, never overwritten
      up.post.sql         ← optional, hand-written, never overwritten
    schema.snapshot.json
  sqlite/
    20260514_120000_initial/
      up.sql
      down.sql
    schema.snapshot.json
```

The two backends drift independently. Their SQL dialects differ, their constraint capabilities differ (SQLite cannot add a `NOT NULL` column without a default in one statement; Postgres can), and their materialized-view stories differ. Treating them as one would just produce least-common-denominator SQL.

### Diff IR

The diff engine produces a backend-agnostic intermediate representation, then per-backend emitters translate to SQL. The IR ops:

```
CreateTable, DropTable, RenameTable
AddColumn, DropColumn, AlterColumnType, AlterColumnNullability,
  AlterColumnDefault, RenameColumn
AddIndex, DropIndex
AddForeignKey, DropForeignKey
AddCheck, DropCheck
CreateView, DropView, ReplaceView
CreateMaterializedView, DropMaterializedView
CreateEnum, AlterEnumAddVariant, RenameEnumVariant, DropEnumVariant, DropEnum
```

Enum ops are emitted only by the Postgres SQL emitter; the SQLite emitter ignores them (see "Enums" below). `AddCheck` / `DropCheck` covers both hand-written `@@check` constraints and `@@db_enforce`-promoted validators (see "Validator promotion" below). `AddForeignKey` / `DropForeignKey` covers foreign keys promoted from `@relation` (see "Foreign-key promotion" below).

Each op carries a **destructiveness class**:

* **safe** — `CreateTable`, `AddColumn` (nullable or with default), `AddIndex`, `CreateView`.
* **lossy** — `DropColumn`, `DropTable`, `AlterColumnType` (narrowing), `DropEnum`. Data is destroyed.
* **blocking** — `AddColumn NOT NULL` on a non-empty table, `AlterColumnNullability` (nullable → not null). The migration cannot succeed without a backfill.

The generator refuses to emit lossy ops without explicit annotation or `--allow-destructive`. Blocking ops require either a `@default` (to backfill in-line) or a hand-written `up.pre.sql` that backfills before the constraint is applied.

### Renames

Schema diffing cannot infer renames from text alone — a column that disappears and a new column that appears look identical to drop-and-add. CrateStack requires **explicit rename annotation**:

```cstack
model Customer {
  emailAddress String  @rename(from = "email")
}
```

The generator reads `@rename` once, emits `ALTER TABLE customer RENAME COLUMN email TO email_address`, and the annotation stays in the schema as a no-op marker. A `cratestack migrate clean-renames` flag strips applied `@rename` markers. Same shape for `@@rename(from = "…")` on models.

Heuristic rename detection is explicitly out of scope. False positives on renames silently destroy data.

### Hand-written escape hatches

Every generated migration directory supports two optional files the generator **never overwrites**:

* `up.pre.sql` — runs before `up.sql` in the same transaction. For backfills, lookup-table seeds, anything the generator can't infer.
* `up.post.sql` — runs after `up.sql` in the same transaction. For derived data updates, refreshing materialized views.

The runner concatenates `up.pre.sql` + `up.sql` + `up.post.sql` and applies them transactionally (per the existing [migrations contract](../guides/migrations)). The hand-written halves are checksummed alongside the generated `up.sql`.

### down.sql

Generated only for non-lossy operations. For lossy ones, the file is emitted with an explicit error:

```sql
-- This migration contains destructive operations and cannot be auto-reversed:
--   - DropColumn customer.legacy_status
-- Write a real reverse migration before running `down`, or accept that this
-- migration is forward-only.
\echo 'destructive migration; reversal must be hand-written'
\quit 1
```

Per the [runner contract](../guides/migrations), `down` is recorded but **never executed automatically**. The error-on-execute posture matches the runner's "irreversible by default" stance.

### View and materialized-view ordering

Views are emitted after their source-model DDL via the explicit `from M, N` dependency list ([ADR 0003](./views-adr)). A column change on a source model that a view selects triggers an automatic `DropView` → source-model alter → `CreateView` sequence within the same migration. Materialized views additionally emit a comment noting that the next manual `refresh()` is the developer's responsibility — the generator does not emit `REFRESH MATERIALIZED VIEW` automatically, for the same reason scheduler-driven refresh is deferred in ADR 0003.

### Enums

Enums are a first-class `.cstack` concept and the generator emits IR ops for them — but the two backends treat them very differently.

**Postgres (server target):** enums map to native `CREATE TYPE … AS ENUM (…)`. Supported alters:

* `CreateEnum` — `CREATE TYPE <name> AS ENUM (…)`. Safe.
* `AlterEnumAddVariant` — `ALTER TYPE <name> ADD VALUE …`. Safe. Postgres requires this to run outside a transaction in some configurations; the generator emits it as its own migration step rather than batching it with other operations.
* `RenameEnumVariant` — `ALTER TYPE <name> RENAME VALUE … TO …`. Safe.
* `DropEnumVariant` — **lossy and multi-step**. Postgres has no `DROP VALUE`; the generator emits a swap sequence (create new type, `ALTER COLUMN … TYPE new_enum USING (…)`, drop old type). Rows referencing the dropped variant must be resolved via `up.pre.sql` first.
* `DropEnum` — lossy. Requires explicit opt-in.

**SQLite (embedded target):** enums are **ignored at the DDL layer**. The field is emitted as plain `TEXT` with no CHECK constraint, no variant enforcement, no table-rebuild dance on variant changes. The Rust enum type is still generated by the macro and used for serialization/deserialization at the runtime layer; the database just stores the variant name as text.

This has two consequences worth being explicit about:

1. **Variant changes are free on the embedded side.** Adding, renaming, or removing a variant generates no SQLite migration. Only the server target produces enum-related DDL.
2. **The embedded backend does not enforce variant validity at the storage layer.** A direct SQL write that inserts an unknown variant string will succeed at the storage layer and fail on the next deserialization. This is consistent with the embedded target's role (single-process, app-owned database) where the Rust layer is the only legitimate writer.

A schema with enums is therefore *fully portable* between backends without per-backend syntax — the divergence is in the emitted DDL, not the schema source.

### Validator promotion (`@@db_enforce`)

Validators ([guides/validators](../guides/validators)) are **app-level by default** — they run in `validate(&self)` at the framework boundary and the database has no record of them. That is the correct default for rich validators (`@email`, `@uri`, complex `@regex`) that rely on host-language parsers and cannot be expressed in pure SQL without semantic drift.

For validators whose semantics translate cleanly to SQL, an opt-in `@@db_enforce` attribute promotes them to database-level CHECK constraints, emitted as `AddCheck` / `DropCheck` IR ops:

```cstack
model Member {
  amount   Decimal @range(min: 0, max: 1000000) @@db_enforce
  currency String  @iso4217                     @@db_enforce
  email    String  @email @length(min: 3, max: 254)   // app-only
}
```

**Translatable validators** (eligible for `@@db_enforce`):

| Validator | Postgres CHECK | SQLite CHECK |
| --- | --- | --- |
| `@range(min, max)` | `col >= min AND col <= max` | same |
| `@length(min, max)` | `length(col) BETWEEN min AND max` | same |
| `@iso4217` | `col ~ '^[A-Z]{3}$'` | `col GLOB '[A-Z][A-Z][A-Z]'` |

**Non-translatable validators** (`@@db_enforce` is a parse-time error on these):

* `@email` — host-language email parsing
* `@uri` — `url::Url::parse` semantics
* `@regex` with patterns outside the portable subset

The generator emits CHECK constraints with stable, predictable names — `<table>_<field>_<validator>_check` (e.g., `member_amount_range_check`) — so they appear consistently in migration diffs and can be referenced from hand-written `up.pre.sql` halves.

**Destructiveness for validator changes:**

* **Loosening** a `@@db_enforce` validator (widening a range, dropping the attribute, lowering a length min) — safe.
* **Tightening** a `@@db_enforce` validator (narrowing a range, raising a length min) — **lossy** unless data already conforms. The generator emits the change behind `--allow-destructive`, and the developer is expected to either resolve violators in `up.pre.sql` or use the application's normal data-migration path before applying.
* **Adding `@@db_enforce` to an existing field** — treated as a tightening, since data written before the attribute existed may not conform. Same opt-in posture.

Validator changes without `@@db_enforce` produce **no migration** — they are pure app-level behavior changes and the database stays exactly as it was.

### Foreign-key promotion (`@relation`)

A `@relation(fields:[...], references:[...])` field previously produced only a plain, same-named column — the emitted DDL carried no database-level reference at all. The owning side of a relation (the field typed as a single model, not a `Model[]` list) now promotes to a real foreign-key constraint, emitted as `AddForeignKey` / `DropForeignKey` IR ops:

```cstack
model Tenant {
  id String @id
}

model Application {
  id       String @id
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
}
```

**Postgres (server target):** emits a real constraint, added after every table/column it depends on already exists in the same migration:

```sql
ALTER TABLE applications
  ADD CONSTRAINT applications_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE;
```

**SQLite (embedded target):** SQLite has no `ALTER TABLE ADD/DROP CONSTRAINT` at all — a foreign key can only be declared inline at `CREATE TABLE` time, which a diff against an existing table never re-runs. Rather than staying silent, the generator emits a marker comment naming the constraint that would otherwise not exist, matching the same posture as `@@db_enforce` CHECK constraints on SQLite (see "Validator promotion" below):

```sql
-- SQLite: ADD CONSTRAINT applications_tenant_id_fkey FOREIGN KEY (tenant_id)
-- REFERENCES tenants (id) ON DELETE CASCADE — requires table rebuild on
-- SQLite. Hand-write up.pre.sql.
```

**Referential actions (`onDelete` / `onUpdate`):** both are optional and accept the SQL-standard vocabulary — `Cascade`, `Restrict`, `SetNull`, `SetDefault`, `NoAction` — as bareword identifiers, matching the schema language's existing convention (`fields:[authorId]`, not `fields:["authorId"]`). `NoAction` is the default and is omitted from the emitted DDL entirely, so a relation declared with no `onDelete`/`onUpdate` emits identical SQL to before this attribute existed. Two rules are enforced at `cratestack check` time rather than surfacing as a runtime `ADD CONSTRAINT` failure:

* An action can only be declared on the relation's **owning side** — the `Model[]` "has-many" side has no physical column, so there is no constraint to attach the action to.
* `SetNull` requires the local FK column to be optional; `SetDefault` requires it to declare `@default(...)`. Postgres enforces both at `ADD CONSTRAINT` time regardless of which action triggers it.

**Ordering:** `AddForeignKey` ops are always emitted after every `CreateTable` / `AddColumn` op in the same migration, so a relation declared alongside two brand-new models resolves correctly regardless of table creation order. `DropTable` ops are topologically sorted within a migration so that a table whose FK references another table being dropped in the same migration drops first — alphabetical order is not safe once a real constraint exists to enforce the dependency.

**Destructiveness:** both `AddForeignKey` and `DropForeignKey` are classified **safe** — the same as `AddIndex` / `DropIndex`. A `FOREIGN KEY` (like a `UNIQUE` index) can fail against pre-existing orphaned data, but the DDL either succeeds outright or the migration transaction aborts; there is no partial data loss either way.

### Verification semantics

`cratestack migrate verify` is the load-bearing CI step. Without it, the snapshot and the migration tree can diverge silently — someone hand-edits the snapshot, or hand-edits an already-applied migration's SQL, and `diff` happily produces no-op or wrong-op output forever after. `verify`:

1. Spawns an ephemeral Postgres (sqlx target) or in-memory SQLite (rusqlite target).
2. Applies every migration in order via the existing [runner](../guides/migrations).
3. Introspects the resulting schema.
4. Compares against the committed snapshot.
5. Fails the build on any mismatch.

This is the only step that catches snapshot tampering. It must be required in CI for the generator to be trustworthy.

### Banking-readiness alignment

* Generated SQL is committed and reviewable. The audit trail is what was *applied*, not what some tool computed in CI.
* `verify` enforces that applied migrations produce the schema the snapshot claims. Drift between source-of-truth schema and applied state is a CI failure, not a runtime surprise.
* `drift` against live production lets ops detect manual hotfixes before the next deploy attempts to re-diff them.
* Lossy operations require explicit opt-in. The default is conservative.

## Consequences

### Positive

* `.cstack` is unambiguously the source of truth for schema, end-to-end.
* Migration authoring becomes a review of generated SQL plus targeted hand-edits, not full hand-translation.
* Three distinct commands prevent conflating generation, verification, and drift detection — three problems that production tools routinely confuse.
* Per-backend separation honors the macro-split discipline.
* Destructive operations remain explicit and reviewable.

### Negative

* The snapshot file is a new committed artifact that can be tampered with. `verify` is the only thing protecting it; teams that skip the CI step lose the safety net.
* The IR + per-backend emitter is real implementation work — non-trivial to ship correctly, especially for `AlterColumnType` across dialects.
* Some operations (renames, backfills) require explicit annotation or hand-written halves. This is more work than fully automatic migration generation pretends to offer, but it is more honest about what schema diffing can and cannot infer.

### Deferred

* **Zero-downtime migration patterns** (expand-contract, dual-write columns) — out of scope. The generator should make these *expressible* via hand-written halves but should not try to generate them automatically.
* **Multi-tenant schema rollouts** (apply migration to N shards) — out of scope.
* **Migration squashing** (collapsing N migrations into one for a fresh checkout) — out of scope until the migration tree gets large enough that fresh setup time matters.

## Shipping order

1. `Schema` snapshot serialization (`serde_json::to_string_pretty`; the type already derives `Serialize`).
2. Diff engine producing the IR. Initial op set: `CreateTable`, `DropTable`, `AddColumn` (safe), `DropColumn`, `AddIndex`, `DropIndex`. Type and nullability changes emit "unsupported, hand-write" stubs.
3. Postgres SQL emitter.
4. SQLite SQL emitter.
5. `cratestack migrate diff` CLI command.
6. `cratestack migrate verify` against ephemeral DBs.
7. `cratestack migrate drift` against live DBs.
8. `AlterColumnType`, `AlterColumnNullability`, `AlterColumnDefault`.
9. `@rename` support.
10. Enum IR ops (Postgres emitter only; SQLite emits TEXT and ignores enum changes).
11. `@@db_enforce` for validators — `AddCheck` / `DropCheck` emission for the translatable subset.
12. View IR ops (`CreateView`, `ReplaceView`, `DropView`).
13. Materialized view IR ops.
14. `AddForeignKey` / `DropForeignKey` — foreign-key promotion from `@relation`, including `onDelete` / `onUpdate` referential actions.

## Read Next

1. [Migrations guide](../guides/migrations) — the runner contract this generator targets
2. [ADR 0003: SQL views as projections of models](./views-adr) — view IR ops are defined here
3. [Banking readiness](../overview/banking-readiness) — auditability requirements that shape the verify/drift split
