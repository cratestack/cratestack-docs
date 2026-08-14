---
title: Optimistic Locking
description: Lost-update protection through the `@version` field, `If-Match` request headers, and `ETag` response headers.
---

# Optimistic Locking

A row that two callers update concurrently can lose one write — both read
`balance = 100`, both compute `balance + 10`, both write `balance = 110`,
and the bank is short ten dollars. Optimistic locking detects this at the
database boundary and rejects the second write with `412 Precondition
Failed`, leaving the row untouched.

## Schema attribute

Add `@version` to one `Int` field per model:

```cstack
model Ledger {
  id Int @id
  label String
  balance Int
  version Int @version
}
```

Constraints enforced at parse time:

1. exactly one `@version` field per model
2. type must be required `Int`
3. cannot also be the primary key

The framework reads the column as `i64` at runtime.

## Update flow

Every successful update emits `version = version + 1` in the same SQL
statement that writes the new state. The generated REST router:

1. returns `ETag: "<version>"` on `GET /resource/<id>` and on the response of any successful mutation
2. requires `If-Match: "<version>"` on `PATCH /resource/<id>` **and** `DELETE /resource/<id>`
3. responds `412 Precondition Failed` on `PATCH` or `DELETE` when `If-Match` is missing
4. responds `412 Precondition Failed` on `PATCH` or `DELETE` when the supplied version is stale
5. distinguishes "stale version" from "row not found" by probing the read policy after the update or delete fails

`DELETE /resource/<id>` enforces `If-Match` the same way `PATCH` does: the
generated delete handler requires the header, rejects a missing or stale
version with `412 Precondition Failed`, and leaves the row untouched on
failure. This closed a prior asymmetry where a concurrent delete could
remove a row out from under a caller holding a stale version — landed via
[#538](https://github.com/cratestack/cratestack/pull/538), which added
`delete_if_match_decl`/`delete_if_match_apply` to
`crates/cratestack-macros/src/axum/model/prep/etag.rs`, deliberately
mirroring `update_if_match_decl`/`update_if_match_apply`. The gate is
purely `descriptor.version_column.is_some()`, independent of
`@@soft_delete` — a soft-deleted row is still a real mutation and gets the
same protection a hard delete does.

```http
PATCH /ledgers/3 HTTP/1.1
If-Match: "0"
Content-Type: application/json

{"balance": 42}

HTTP/1.1 200 OK
ETag: "1"
Content-Type: application/json

{"id": 3, "balance": 42, "version": 1}
```

```http
DELETE /ledgers/3 HTTP/1.1
If-Match: "1"

HTTP/1.1 204 No Content
```

Omitting `If-Match`, or sending a stale version, on either request returns
`412 Precondition Failed` and leaves the row untouched.

## Programmatic use

Internal Rust callers thread the expected version through `if_match`:

```rust
let updated = cool
    .ledger()
    .update(3)
    .set(UpdateLedgerInput { balance: Some(42), ..Default::default() })
    .if_match(0)
    .run(&ctx)
    .await?;
```

`delete` takes the same builder:

```rust
let deleted = cool
    .ledger()
    .delete(3)
    .if_match(1)
    .run(&ctx)
    .await?;
```

Omitting `if_match` on a versioned model returns `CratestackError::PreconditionFailed`
before any SQL runs, for both `update` and `delete`. Banks treat the version
check as a contract, not a hint — there is no "force update" or "force
delete" escape hatch on the generated path.

## Input filtering

`@version` is excluded from both `Create<Model>Input` and `Update<Model>Input`:

1. clients cannot seed the initial version on create — the framework sets it to `0`
2. clients cannot replay or skip a version through a PATCH body — the column is bumped server-side

If a future change re-added the field, the generated Rust input struct
would no longer compile against existing call sites — that's the primary
line of defence.

## Interaction with `@@soft_delete`

Soft-delete tombstones bump the version column too, so callers that re-read
after a delete observe a fresh `ETag`. Live updates against a tombstoned
row match zero rows and return the same "precondition failed" shape.

## When to use it

Add `@version` to:

1. balances, ledger entries, transfers, holds, reservations
2. any row a workflow reads, decides on, then writes back
3. any row a webhook can update concurrently with a user-facing flow

Skip it for:

1. append-only event tables
2. rows updated by exactly one writer (lookup tables, configuration)
3. denormalised counters that already use SQL-level atomic increments

## Read Next

1. [Idempotency](./idempotency) — protects against duplicate execution; complements lost-update protection
2. [Transaction isolation](./transaction-isolation) — closes the read-write skew window inside the same transaction
3. [Field attributes](../reference/field-attributes) — full list of supported field attributes
