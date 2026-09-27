---
title: Soft Delete
description: Tombstone-based delete via `@@soft_delete` — preserves the row, scopes reads, bumps version.
---

# Soft Delete

Regulated workloads often forbid hard deletes: a customer record removed
today may need to be reconstructed for a chargeback in three years. Soft
delete preserves the row, marks it as deleted, and scopes every subsequent
read so the tombstoned row is invisible to the application.

## Schema attribute

```cstack
model Customer {
  id Int @id
  email String
  deletedAt DateTime?

  @@soft_delete
  @@allow("read", auth() != null)
  @@allow("update", auth() != null)
  @@allow("delete", auth() != null)
}
```

Constraints enforced at parse time:

1. `@@soft_delete` takes no arguments

Unlike `@@paged`, `@@emit`, and `@@id` — which do reject a duplicate
declaration at parse time — `@@soft_delete` has no such check today. A
second `@@soft_delete` on the same model is silently ignored (a no-op),
not rejected.

The runtime currently uses a fixed column name of `deleted_at`. The model
does not need a field for it: the generated SQL names the column directly
(measured on 0.14.0 with a model that declares none). The **table** does need
a nullable timestamp column called `deleted_at`, and `cratestack migrate`
creates columns only for declared fields — it has no soft-delete handling —
so either add the column in a migration of your own
(`ALTER TABLE … ADD COLUMN deleted_at TIMESTAMPTZ`) or declare a nullable
`DateTime?` field that maps to it.

## Runtime behaviour

For a soft-delete model:

1. `delete(id)` issues `UPDATE table SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`
2. if the model also declares `@version`, the same statement bumps the version column
3. `find_unique`, `find_many`, `update`, and `delete` all add `deleted_at IS NULL` to their predicates
4. `delete` against an already-tombstoned row matches zero rows and surfaces as `Forbidden` (`403`,
   `"delete policy denied this operation"`) — the same answer as a missing row or a policy denial —
   and `deleted_at` does not move (measured on 0.14.0)
5. *(since 0.13.0, server role)* a relation filter or relation sort that reaches the model from
   another one skips tombstoned rows too: REST `?customer.email=` or `sort=customer.email` on a
   model related to `Customer`, `some` / `every` / `none` over a to-many relation, RPC
   `model.<M>.list`, and the typed Rust builder alike.
   A tombstoned related row behaves as if it did not exist, as it already did under `?include=`:
   a to-one filter does not match it and a relation sort key through it reads as `NULL`. From
   0.2.0 through 0.12.0 these subqueries ignored the soft-delete column, so a caller could still
   filter and sort by values of tombstoned related rows. See
   [Relation filters and sorts](../reference/auth-support-matrix#relation-filters-and-sorts)

On the embedded role (`include_embedded_schema!`), `find_*` hides tombstoned rows, but relation
filters and sorts still see tombstoned related rows.

The tombstoned row remains visible in raw SQL queries — banks running
forensic recovery or compliance review read the table directly.

## Interaction with optimistic locking

The soft-delete `UPDATE` includes `version = version + 1`. Callers
holding a stale `ETag` cannot re-tombstone a row that has already moved on,
and the post-delete version is observable to subsequent reads that the
review tooling performs directly against the table.

## Interaction with audit

A soft delete records an `AuditOperation::Delete` event with the full
`before` snapshot. The audit row's data outlives any future cold-storage
migration of the tombstoned row; the framework keeps both in step but
manages neither's retention.

## What this is not

1. not a "trash bin" with restore semantics — there is no `undelete`
   helper; banks that need restore call SQL directly
2. not a substitute for backups — a `DROP TABLE` removes both live and
   tombstoned rows
3. not a cascade engine — child rows are not automatically tombstoned
   when a parent is. Reference-counted cleanup is application policy

## When to use it

Apply `@@soft_delete` to:

1. customer / account / counterparty records
2. transfer instructions and reservations that may need to be reviewed after settlement
3. anything a regulator can request the historical state of

Skip it for:

1. genuinely ephemeral data (session tokens, throttle buckets)
2. tables that already have an immutable event-source upstream
3. tables under a strict "right to be forgotten" obligation — hard delete is the correct behaviour there

## Read Next

1. [Optimistic locking](./optimistic-locking) — `@version` pairs with `@@soft_delete` so reviewers see coherent state
2. [Audit log](./audit-log) — the canonical "what happened" log when the row itself stops being visible
