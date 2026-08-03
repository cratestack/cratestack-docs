---
title: Batches
description: Five batch primitives — `batch_get`, `batch_create`, `batch_update`, `batch_delete`, `batch_upsert` — with a tRPC-style per-item envelope and savepoint isolation.
---

# Batches

External producers send rows in groups: a webhook delivers ten transactions, a CSV import fans out a thousand line items, an offline-first device flushes its outbox after reconnecting. CrateStack exposes five batch ORM primitives that take those groups whole, run each item independently, and return a structured envelope per item so the caller can split successes from failures without unwrapping a flat error.

This page is about that server-side ORM concept — a handler deliberately calling `batch_create`/`batch_update`/etc. with an array of rows. It's unrelated to `@cratestack/api`'s `createBatchLink`, which is client-side automatic RPC-call coalescing (N small calls a caller already made → 1 `/rpc/batch` request, transparently). See [RPC transport: automatic call coalescing](./rpc-transport#automatic-call-coalescing-with-cratestackapi) for that.

## Wire envelope

Every batch call returns a [`BatchResponse<M>`](https://docs.rs/cratestack-core/latest/cratestack_core/struct.BatchResponse.html) with a `Vec<BatchItemResult<M>>` and a summary count:

```json
{
  "results": [
    { "index": 0, "status": "ok",    "value": { ... } },
    { "index": 1, "status": "error", "error": { "code": "POLICY_DENIED", "message": "..." } },
    { "index": 2, "status": "ok",    "value": { ... } }
  ],
  "summary": { "total": 3, "ok": 2, "err": 1 }
}
```

Two layers of error reporting:

1. **The outer `Result<BatchResponse<M>, CoolError>`** carries _whole-batch infrastructure_ failures only: request exceeds the 1000-item cap, duplicate keys detected in the input list, database connection lost. Outer failures stop the batch before any per-item work runs.
2. **`BatchItemStatus::Error`** carries _per-item_ failures: validation failed, policy denied, row not found, `if_match` was stale, primary key already existed. Per-item failures _do not_ abort the rest of the batch — the savepoint rolls back just that item.

The `index` on every `BatchItemResult` is the item's position in the original request, preserved across the response. Clients can match results back to inputs by index without depending on ordering.

## The five primitives

```rust
// 1. Fetch many by PK — single SELECT, missing rows → NOT_FOUND.
let response = cool.account()
    .batch_get(vec![1, 2, 999])
    .run(&ctx)
    .await?;

// 2. Insert many — per-item savepoints isolate failures.
let response = cool.account()
    .batch_create(vec![input_a, input_b, input_c])
    .run(&ctx)
    .await?;

// 3. Update many — per-item patches with optional `if_match` per row.
let response = cool.account()
    .batch_update(vec![
        (1, UpdateAccountInput { balance: Some(100), ..Default::default() }, Some(0)),
        (2, UpdateAccountInput { active: Some(false), ..Default::default() }, None),
    ])
    .run(&ctx)
    .await?;

// 4. Delete many by PK — single statement, missing rows → NOT_FOUND.
let response = cool.account()
    .batch_delete(vec![1, 2])
    .run(&ctx)
    .await?;

// 5. Upsert many — eligible only on models with client-supplied @id.
let response = cool.account()
    .batch_upsert(vec![input_a, input_b])
    .run(&ctx)
    .await?;
```

## Transactional model

Two patterns, picked per primitive:

| Operation | SQL shape | Why |
|---|---|---|
| `batch_get` | One `SELECT … WHERE pk IN (…)` | Policy merges into WHERE; missing rows are naturally `NOT_FOUND`. No mutation, no savepoints needed. |
| `batch_delete` | One `DELETE … WHERE pk IN (…) RETURNING …` (or soft-delete `UPDATE`) | Policy merges into WHERE. The returned rows become the audit before-snapshots; missing rows surface as `NOT_FOUND`. |
| `batch_create` | One outer `BEGIN`, per-item `SAVEPOINT … INSERT … RELEASE` | Per-item failures (validation, policy, unique conflict) roll back to their savepoint without taking the rest of the batch down. |
| `batch_update` | Same pattern as `batch_create`, per-item `UPDATE` | Each item carries its own optional `if_match`; per-item version mismatches surface as `PRECONDITION_FAILED` in their envelope slot. |
| `batch_upsert` | Same pattern, per-item probe + `INSERT … ON CONFLICT … DO UPDATE` | Inherits the full upsert semantics (see the [Upsert guide](./upsert)) on a per-item basis. |

Successful items in a savepointed batch commit together at the outer commit; failed items leave no row, no audit row, no event outbox entry. The audit log gets one row per successful item, all with the same outer-commit timestamp — forensics treats them as one operation, even though each was savepointed independently.

### Why the SAVEPOINT pattern

In a flat single-transaction batch, a per-item constraint violation aborts the transaction — Postgres marks the connection's current transaction as failed and refuses further statements until you `ROLLBACK`. That model doesn't fit the tRPC-envelope contract: we promised the caller that item N+1 still gets a chance.

Savepoints solve this exactly. `ROLLBACK TO SAVEPOINT` returns the outer transaction to a usable state without losing earlier work. The outer commit then writes only the successful items, atomically together with their audit and outbox rows.

## Size cap and duplicate handling

```rust
pub const BATCH_MAX_ITEMS: usize = 1000;
```

Server backends reject over-sized batches at the outer guard with `CoolError::Validation`, before any SQL runs. The cap is the same for all five operations; deviating per-op would invite footguns where `batch_get` accepts a list that `batch_create` of the same length rejects.

**Duplicate input keys are loud-failed**, not silently deduplicated:

```rust
// This returns Err(CoolError::Validation("duplicate primary key in batch at positions 0 and 2")).
cool.tag().batch_get(vec![dup, other, dup]).run(&ctx).await
```

The reason is index integrity: the envelope promises that `results[i]` corresponds to the input at position `i`. Silent dedup would break that contract — the caller passes 3 items and gets back 2 results, with no way to tell which positions collapsed. Loud-failing forces the caller to dedupe at the boundary they own.

Detection runs on the natural key per operation:

- **`batch_get` / `batch_delete`**: the PK list itself
- **`batch_update`**: the `id` field of each `BatchUpdateItem<PK, I>`
- **`batch_upsert`**: `UpsertModelInput::primary_key_value()` on each input

**`batch_create` skips the check** — `CreateModelInput` doesn't expose the primary key generically, and server-generated PKs can't collide by construction. Duplicate client-supplied PKs in a `batch_create` will trip the database's unique constraint and surface as per-item `CONFLICT` in the envelope, with the rest of the batch committing cleanly via savepoint isolation. If you need explicit boundary dedup on a `batch_create`, dedupe before the call.

## Per-item error codes

Per-item `BatchItemError { code, message }` uses the same string codes as the framework's standard HTTP responses, so client-side error-mapping tables work uniformly across single and batch routes:

| Code | When |
|---|---|
| `VALIDATION_ERROR` | input failed `@length`, `@regex`, `@email`, etc. |
| `FORBIDDEN` | create/update/delete policy denied this item |
| `NOT_FOUND` | `batch_get` / `batch_update` / `batch_delete` saw no row at this PK |
| `PRECONDITION_FAILED` | versioned `batch_update` with stale `if_match` |
| `CONFLICT` | a unique constraint was tripped (incl. duplicate client PKs) |
| `DATABASE_ERROR` | unexpected DB failure — usually means escalate via outer error |

The codes mirror `CoolError::code()` so a single mapping table covers single-route responses and batch envelope entries.

`CONFLICT` isn't specific to `batch_create` — `classify_unique_violation` is
shared uniformly across `batch_create`, `batch_update`, and `batch_upsert`,
so a unique-constraint hit on any of the three (a `batch_update` colliding
on a unique column, or a `batch_upsert` conflict) surfaces the same
`CONFLICT` code in its envelope slot, not just duplicate PKs on create.

## Comparison with `IdempotencyLayer` and `.upsert(...)`

Three orthogonal primitives, three different replays:

| | `IdempotencyLayer` | `.upsert(...)` | `.batch_*(...)` |
|---|---|---|---|
| Scope | One HTTP request | One row | One transaction with N rows |
| Key | `Idempotency-Key` header | Model primary key | Per-item PK / input |
| Replay | Returns captured response | Re-executes against current row | Re-runs the batch (envelope shows current state per item) |
| Failure model | All-or-nothing per request | All-or-nothing per row | Per-item independent |

Use them together when ingesting from a high-retry producer:

- `IdempotencyLayer` protects against duplicate _handler executions_ caused by client retries on a flaky network.
- `.batch_upsert(...)` makes the _payload itself_ idempotent — replays converge to the same row state regardless of how many times the same item appears.
- `.batch_*(...)` envelope semantics let the caller decide per-item what to do about failures (retry only the failed ones, surface specific items to a human, log and continue).

## Embedded backend (`cratestack-rusqlite`)

All five primitives are available on the embedded `ModelDelegate` too. The path is sync (`.run()` instead of `.run().await`) and noticeably thinner: no policy enforcement, no audit, no event outbox. SAVEPOINT semantics carry over directly — SQLite supports `SAVEPOINT … RELEASE … ROLLBACK TO` the same way Postgres does, so the per-item isolation contract holds on-device.

```rust
let response = delegate
    .batch_create(vec![input_a, input_b])
    .run()?;
```

Per-item errors on the embedded path surface as `BatchItemError { code: "DATABASE_ERROR" }` or `code: "CONFLICT"` (constraint violations); we don't enumerate `VALIDATION_ERROR` / `FORBIDDEN` because the embedded layer doesn't run validators or policies. The codes still match the server side so cross-platform clients keep a single error-mapping table.

The embedded `batch_update` doesn't support per-item `if_match` — the on-device runtime doesn't enforce `@version` for single rows either, so consistency wins over surprise. If a future on-device version-check use case appears, the API knob is non-breaking to add.

## HTTP

Auto-generated `POST /<model>/batch-*` routes are **deferred** to a follow-up release. The wire envelope types — [`BatchRequest<I>`](https://docs.rs/cratestack-core/latest/cratestack_core/struct.BatchRequest.html) and [`BatchResponse<T>`](https://docs.rs/cratestack-core/latest/cratestack_core/struct.BatchResponse.html) — are stable in `cratestack-core` today, so applications can hand-roll a thin axum handler against the ORM:

```rust
use axum::{extract::State, Json};
use cratestack::{BatchRequest, BatchResponse, CoolError};
use cratestack_schema::{CreateAccountInput, Account};

pub async fn batch_create_accounts(
    State(state): State<AppState>,
    Json(req): Json<BatchRequest<CreateAccountInput>>,
) -> Result<Json<BatchResponse<Account>>, CoolError> {
    let response = state.cool
        .account()
        .batch_create(req.items)
        .run(&state.ctx)
        .await?;
    Ok(Json(response))
}
```

The follow-up auto-route emission will preserve this exact shape; lifting hand-rolled handlers onto the generated path will be a deletion, not a migration.

## Worked example: the `notes` CLI

The [`embedded-cli` example](https://github.com/cratestack/cratestack/tree/main/examples/embedded-cli) ships three batch-aware subcommands so you can see the envelope in actual terminal output rather than just JSON snippets:

```text
$ cargo run -p embedded-cli-example -- import notes.json
OK  [0] 11111111-1111-1111-1111-111111111111  first
OK  [1] 22222222-2222-2222-2222-222222222222  second
summary: 2 total, 2 ok, 0 err

$ cargo run -p embedded-cli-example -- bulk-done \
    11111111-1111-1111-1111-111111111111 \
    99999999-9999-9999-9999-999999999999
OK  [0] 11111111-…  first
ERR [1] NOT_FOUND: no row matched
summary: 2 total, 1 ok, 1 err

$ cargo run -p embedded-cli-example -- bulk-delete \
    11111111-1111-1111-1111-111111111111 \
    22222222-2222-2222-2222-222222222222 \
    99999999-9999-9999-9999-999999999999
OK  [0] 11111111-…  first
OK  [1] 22222222-…  second
ERR [2] NOT_FOUND: no row matched
summary: 3 total, 2 ok, 1 err
```

| Subcommand | Primitive | Notes |
|---|---|---|
| `notes import <file.json>` | `batch_upsert` | Idempotent JSON ingestion. Re-running the same file converges instead of duplicating. |
| `notes bulk-done <id...>` | `batch_update` | Missing ids surface as per-item `NOT_FOUND` without aborting the successful ones. |
| `notes bulk-delete <id...>` | `batch_delete` | Single statement; ids that didn't match (or were already tombstoned, on soft-delete models) surface as per-item `NOT_FOUND`. |

The `print_envelope()` helper at the bottom of [`examples/embedded-cli/src/main.rs`](https://github.com/cratestack/cratestack/blob/main/examples/embedded-cli/src/main.rs) is six lines and copy-paste-ready for any sync rusqlite-backed app.
