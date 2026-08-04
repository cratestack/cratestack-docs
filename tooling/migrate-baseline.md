---
title: Adopting an Existing Database
description: Walk `cratestack migrate baseline` through a real, already-populated Postgres database — reading the drift report and confirming the follow-up `migrate diff` produces incremental migrations, not a full recreate.
---

# Adopting An Existing Database

Most teams don't start with `cratestack migrate diff`. They start with a Postgres database
that already has tables — hand-created, inherited from a prior tool, or managed by a
previous internal migration system — and no `cratestack_migrations` history at all. Pointing
`cratestack migrate diff` at that database with no baseline produces a full `CREATE TABLE`
for everything it finds, because `diff` has no way to know the tables already exist.

`cratestack migrate baseline` (issue [#205](https://github.com/cratestack/cratestack/issues/205),
design doc [`migrate-baseline.md`](https://github.com/cratestack/cratestack/blob/main/docs/design/migrate-baseline.md))
solves exactly that: it introspects the live database, reports how it differs from `.cstack`, and
writes a snapshot **from what it actually found** — so the very next `migrate diff` treats the
existing tables as already accounted for and proposes only the incremental change.

This page walks that command end to end against a real, dockerized Postgres 18 database, using the
`cratestack-cli` binary built from `cratestack/cratestack` main (merged via
[PR #397](https://github.com/cratestack/cratestack/pull/397)). Every command and every output block
below is copied verbatim from an actual run — see [Verification](#verification) at the end for the
exact setup.

## Prerequisites

- A live Postgres database reachable from wherever you run `cratestack`. Baselining is
  **Postgres-only for v1** — there is no `--backend sqlite`/`both` option (design doc §6).
- `cratestack-cli` installed — see [Installing the CLI](./cli-install).
- A `.cstack` schema describing the shape you want the database to end up matching. It does not
  need to match the live database exactly; baselining is designed for the case where it doesn't.
- No `migrations/postgres/schema.snapshot.json` yet for this project. `migrate baseline` refuses to
  run if one already exists — see [Refusing a second baseline](#refusing-a-second-baseline) below.

## The scenario

Say you've inherited a Postgres database with a `customers` and an `orders` table, created outside
CrateStack, with rows already in it:

```sql
CREATE TABLE customers (
    id BIGINT NOT NULL,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE orders (
    id BIGINT NOT NULL,
    customer_id BIGINT NOT NULL,
    total_cents BIGINT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (id)
);

CREATE UNIQUE INDEX customers_email_key ON customers (email);
```

And a `.cstack` schema that describes the same shape:

```cstack
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

model Customer {
  id Int @id
  email String @unique
  fullName String
  createdAt DateTime
}

model Order {
  id Int @id
  customerId Int
  totalCents Int
  status String
}
```

## Running `migrate baseline`

```bash
cratestack migrate baseline \
  --schema schema.cstack \
  --database-url "postgres://cratestack:cratestack@localhost:5432/cratestack_test" \
  --out-dir migrations
```

Against the matching database above, this is a **clean baseline** — the live shape and the schema
agree exactly:

```text
no drift: the live database matches the schema exactly

migrate baseline: wrote migrations/postgres/schema.snapshot.json and recorded baseline
`20260804020846_baseline` in cratestack_migrations
```

Exit code `0`. Two things happened:

1. `migrations/postgres/schema.snapshot.json` was written **from the introspected database**, not
   from `schema.cstack`. For a clean baseline like this one they're identical, but see the drift
   scenario below for a case where they aren't. The snapshot is CrateStack's post-#397
   [`format_version: 2`](https://github.com/cratestack/cratestack/pull/397) — it stores the
   `Projections` IR directly rather than a full reconstructed schema, which is what makes writing it
   straight from a live-introspected shape possible at all.
2. A synthetic row was inserted into `cratestack_migrations` in the target database:

   ```text
              id            |              description              |          applied_at
   -------------------------+-----------------------------------------+-------------------------------
    20260804020846_baseline | baseline: adopted 2 existing table(s)    | 2026-08-04 02:08:46.122883+00
   ```

   This row doesn't run any DDL — the tables already exist — but it means a later
   `cratestack_sqlx::apply_pending()` run against this same database won't try to replay a
   generated "create everything" migration against tables baseline already accounted for. See
   [Migrations](./../guides/migrations) for what that table and that runner do more generally.

## Refusing a second baseline

Running the exact same command again, against the same `--out-dir`, refuses outright:

```text
Error: migrate baseline: a snapshot already exists at migrations/postgres/schema.snapshot.json —
refusing to overwrite an already-managed backend. Remove it first if you really intend to re-baseline.
```

Exit code `1`, no writes, no database round-trip. This is deliberate: baselining an
already-`cratestack`-managed backend is almost certainly a mistake, and silently overwriting a real
migration history is a worse failure mode than requiring an explicit
`rm migrations/postgres/schema.snapshot.json` first.

## Confirming the follow-up `migrate diff`

This is the acceptance bar for the whole feature: after a clean baseline, `migrate diff` against the
unchanged schema reports nothing pending.

```bash
cratestack migrate diff --schema schema.cstack --out-dir migrations --backend postgres --name post_baseline_check
```

```text
migrate diff [postgres]: no changes
migrate diff: schema is in sync with all selected backends
```

No migration directory is written. Now add a field to the schema:

```cstack
model Customer {
  id Int @id
  email String @unique
  fullName String
  createdAt DateTime
  loyaltyNote String?
}
```

```bash
cratestack migrate diff --schema schema.cstack --out-dir migrations --backend postgres --name add_loyalty_note
```

```text
migrate diff [postgres]: wrote migrations/postgres/20260804020909_add_loyalty_note (safe)
```

```sql
-- migrations/postgres/20260804020909_add_loyalty_note/up.sql
ALTER TABLE customers ADD COLUMN loyalty_note TEXT;
```

An incremental `ALTER TABLE ADD COLUMN` — not a `CREATE TABLE customers (...)`. This is exactly the
regression this feature exists to fix: before baselining, `migrate diff` had no record that
`customers` already existed, so every diff would have proposed recreating it from scratch. The
project's own test suite pins this exact behavior as
[`clean_baseline_then_added_field_produces_alter_table_not_create_table`](https://github.com/cratestack/cratestack/blob/main/crates/cratestack-cli/src/migrate/tests_baseline/regression.rs).

## Interpreting the drift report

Real databases rarely match the schema byte-for-byte on day one. Say the inherited database instead
looks like this — an extra column `.cstack` doesn't know about, and a missing unique index:

```sql
CREATE TABLE customers (
    id BIGINT NOT NULL,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    legacy_crm_id TEXT,
    PRIMARY KEY (id)
);
-- no unique index on customers.email
```

Baselining against the same `.cstack` schema as before now reports drift, but **still succeeds**:

```text
drift detected in 1 table(s)/view(s) (2 change(s) total):

customers:
  [lossy] column `legacy_crm_id` exists in the live database but is not declared in the schema
  [safe] index `customers_email_key` is declared in the schema but does not exist in the live database

migrate baseline: wrote migrations/postgres/schema.snapshot.json and recorded baseline
`20260804020948_baseline` in cratestack_migrations
```

Exit code `0`. Read the report like this:

- Grouped **by table** (`customers`), one line per drifted column, index, or constraint.
- Each line is tagged with a [`Destructiveness`](https://github.com/cratestack/cratestack/blob/main/crates/cratestack-migrate/src/checksum.rs)-derived severity: `safe` (a missing index — cheap to add back), `lossy` (an undeclared column — dropping it would destroy data if you ever reconcile toward the schema), or `blocking` (not triggered here, reserved for changes the diff engine can't express safely at all).
- Baselining **reports** drift, it does not **resolve** it. The snapshot is written from the
  live shape as introspected — `legacy_crm_id` and all — not from `schema.cstack`. That's
  deliberate: the drift becomes visible as a *pending* change the next time you run `migrate diff`,
  rather than silently disappearing.

Running the same command with `--strict` on the same drifted database flips the default:

```bash
cratestack migrate baseline --schema schema.cstack --database-url "$DB_URL" --out-dir migrations --strict
```

```text
drift detected in 1 table(s)/view(s) (2 change(s) total):

customers:
  [lossy] column `legacy_crm_id` exists in the live database but is not declared in the schema
  [safe] index `customers_email_key` is declared in the schema but does not exist in the live database

Error: migrate baseline: --strict refuses to baseline with 2 pending drift change(s); resolve the
drift above (or drop --strict) and try again. No snapshot was written and no baseline row was recorded.
```

Exit code `1`, and — unlike the default mode — **nothing is written**: no snapshot, no
`cratestack_migrations` row. `--strict` is for a different job than adoption: proving in CI that a
database already matches the schema exactly, rather than adopting one that doesn't.

### Reconciling drift afterward

Once a drifted database has been baselined (in the default, non-strict mode), the drift it reported
is now sitting in the snapshot as "pending" from `migrate diff`'s point of view — and because
`legacy_crm_id`'s removal is a `DROP COLUMN`, it's destructive:

```bash
cratestack migrate diff --schema schema.cstack --out-dir migrations --backend postgres --name reconcile_drift
```

```text
Error: migrate diff [postgres]: refusing to write destructive migration without --allow-destructive.
The diff contains DROP operations that would destroy data on apply.
```

`--allow-destructive` is the explicit opt-in:

```bash
cratestack migrate diff --schema schema.cstack --out-dir migrations --backend postgres --name reconcile_drift --allow-destructive
```

```sql
ALTER TABLE customers DROP COLUMN legacy_crm_id;

CREATE UNIQUE INDEX customers_email_key ON customers (email);
```

Whether you actually want to apply that `DROP COLUMN` — versus keeping `legacy_crm_id` and adding it
to `schema.cstack` instead — is exactly the kind of call baselining deliberately leaves to a human,
per its explicit "report drift, don't reconcile it automatically" design.

## Flags reference

```text
Usage: cratestack migrate baseline [OPTIONS] --schema <SCHEMA> --database-url <DATABASE_URL>

Options:
      --schema <SCHEMA>
      --database-url <DATABASE_URL>  Postgres connection string to introspect. Required — also the
                                      database the synthetic baseline row is recorded into.
      --out-dir <OUT_DIR>            Root directory for per-backend migration trees [default: migrations]
      --backend <BACKEND>            Baseline is Postgres-only for v1 [default: postgres] [possible values: postgres]
      --strict                       Fail (non-zero exit, no writes) if any drift is found
```

## Verification

Every command and output block above was run against a real `postgres:18` container (not a mock),
using `cratestack-cli` built from `cratestack/cratestack@main` (commit `1dc8344`, which includes
[PR #397](https://github.com/cratestack/cratestack/pull/397)):

```bash
git clone https://github.com/cratestack/cratestack.git
cd cratestack
cargo build -p cratestack-cli

docker run -d --name cratestack-baseline-doc-pg \
  -e POSTGRES_USER=cratestack -e POSTGRES_PASSWORD=cratestack -e POSTGRES_DB=cratestack_test \
  -p 55499:5432 postgres:18

# clean scenario: create the matching customers/orders tables, then
./target/debug/cratestack migrate baseline --schema schema.cstack \
  --database-url "postgres://cratestack:cratestack@localhost:55499/cratestack_test?options=-c%20search_path%3Dexisting_prod" \
  --out-dir migrations
./target/debug/cratestack migrate baseline --schema schema.cstack --database-url "$SAME_URL" --out-dir migrations   # refuses, exit 1
./target/debug/cratestack migrate diff --schema schema.cstack --out-dir migrations --backend postgres --name post_baseline_check   # "no changes"
# edit schema.cstack to add Customer.loyaltyNote, then
./target/debug/cratestack migrate diff --schema schema.cstack --out-dir migrations --backend postgres --name add_loyalty_note   # ALTER TABLE ADD COLUMN

# drift scenario: a second schema (drifted_prod) with an extra column and a missing index
./target/debug/cratestack migrate baseline --schema schema.cstack --database-url "$DRIFTED_URL" --out-dir migrations-strict --strict   # exit 1, no writes
./target/debug/cratestack migrate baseline --schema schema.cstack --database-url "$DRIFTED_URL" --out-dir migrations-drift             # exit 0, drift printed, writes
./target/debug/cratestack migrate diff --schema schema.cstack --out-dir migrations-drift --backend postgres --name reconcile_drift                          # refuses, exit 1
./target/debug/cratestack migrate diff --schema schema.cstack --out-dir migrations-drift --backend postgres --name reconcile_drift --allow-destructive      # DROP COLUMN + CREATE UNIQUE INDEX
```

Both the clean-baseline path (baseline → refuse-on-repeat → no-op diff → incremental `ALTER TABLE`
after a schema change) and the drift path (`--strict` fails closed with zero writes; default mode
reports and still writes; the follow-up `migrate diff` requires `--allow-destructive` for the
resulting `DROP COLUMN`) match the design doc's [§8 test plan](https://github.com/cratestack/cratestack/blob/main/docs/design/migrate-baseline.md#8-test-plan-phase-c-mapped-to-issue-acceptance-criteria)
and the project's own [`tests_baseline`](https://github.com/cratestack/cratestack/tree/main/crates/cratestack-cli/src/migrate/tests_baseline) integration suite, which this walkthrough independently reproduced by hand.

Source of truth: [issue #206](https://github.com/cratestack/cratestack/issues/206) (this page),
parent epic [#202](https://github.com/cratestack/cratestack/issues/202), originating issue
[#135](https://github.com/cratestack/cratestack/issues/135).

## Read Next

1. [Migrations](../guides/migrations) — the forward-only migration runner and `cratestack_migrations` table that baselining's synthetic row plugs into.
2. [Schema diff (CLI)](./schema-diff) — `cratestack diff`, the sibling command that checks wire-contract-breaking changes rather than DB schema changes.
3. [Installing the CLI](./cli-install) — get `cratestack-cli` without a Rust toolchain.
4. [Composite keys](../reference/composite-keys) — `@@id([...])`/`@@unique([...])`, relevant to how baselining projects primary keys and unique indexes.
