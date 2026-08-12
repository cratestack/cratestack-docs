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
must declare a nullable `DateTime?` field that maps to this column.

## Runtime behaviour

For a soft-delete model:

1. `delete(id)` issues `UPDATE table SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`
2. if the model also declares `@version`, the same statement bumps the version column
3. `find_unique`, `find_many`, `update`, and `delete` all add `deleted_at IS NULL` to their predicates
4. `delete` against an already-tombstoned row matches zero rows and surfaces as `not found`

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
