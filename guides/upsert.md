---
title: Upsert
description: Insert-or-update on primary-key conflict via `.upsert(input)`, with policy enforcement, event/audit fan-out, and `@version` bumps handled by the runtime.
---

# Upsert

External integrators replay the same payload — webhook redeliveries, file
imports, retry loops after a network drop. The right primitive for "make the
row look like this, whether or not it already exists" is upsert, keyed on a
stable identifier the producer owns. CrateStack exposes it as `.upsert(input)`
on every model whose primary key is client-supplied.

## When to use it

1. **Idempotent ingestion** — an external producer (payment processor, CSV
   import, message-queue consumer) sends events with stable IDs that you
   want to converge to, not duplicate
2. **Cache rehydration** — re-deriving a projection from a source-of-truth
   stream where each event already carries the resulting row state
3. **CRDT-style materializations** — when the input fully describes the
   desired state and you don't care whether the row was new

Use `.create(...)` when you want a duplicate-key error to surface a bug.
Use `.update(...)` when "row must already exist" is a precondition.

## Eligibility

`.upsert(...)` is generated only on models whose `@id` field is
**client-supplied** — i.e. has no `@default(...)`. Calling `.upsert(...)`
on a model with a server-generated PK (`@id @default(cuid())`,
`@id @default(uuid_v7())`, etc.) is a **compile error**, not a runtime
"not supported."

```cstack
// ✅ Eligible — client supplies the id.
model Tag {
  id Uuid @id
  label String
}

// ❌ Not eligible — server generates the id, so no conflict target
// is reachable by the caller.
model Account {
  id Cuid @id @default(cuid())
  ownerEmail String
}
```

The compile-time gate is intentional: a server-PK upsert can't target a
specific row without leaking server identity to the caller, and v1 doesn't
support unique-key (non-PK) conflict targets. Widening to `@unique`
columns — including [composite `@@unique([...])`](../reference/composite-keys)
constraints, which are enforced in the database but not yet reachable
from this builder — is a future, non-breaking addition.

## Programmatic use

The input shape is the same `Create<Model>Input` struct you already use
for `.create(...)`. The runtime decides at call time whether the call
becomes an INSERT or an UPDATE.

```rust
// Server (sqlx) — async, scoped to a request context.
let tag = cool
    .tag()
    .upsert(CreateTagInput {
        id: external_id,
        label: payload.label,
    })
    .run(&ctx)
    .await?;

// Or pre-bound for a request-scoped delegate:
let tag = cool
    .tag()
    .bind(ctx)
    .upsert(CreateTagInput { id, label })
    .run()
    .await?;

// Embedded (rusqlite) — sync, no policy/audit layer.
let tag = delegate
    .upsert(CreateTagInput { id, label })
    .run()?;
```

Replays converge:

```rust
for _ in 0..3 {
    delegate.upsert(input.clone()).run()?;
}
// Exactly one row, with the final input's values.
```

## Server semantics

The server (`cratestack-sqlx`) path is always transactional and follows a
deliberate, banking-friendly sequence:

1. **Validate input** — schema-derived validators (`@length`, `@regex`, …)
   run before any SQL
2. **Apply create defaults** — `@default(auth().*)` and `@default(...)`
   columns are filled in
3. **Evaluate create policies** — `@@allow(create, …)` and `@@deny(create, …)`
   must permit the call, against the input values plus defaults
4. **Begin transaction**, ensure outbox / audit tables exist
5. **Probe with `SELECT … FOR UPDATE`** on the primary key — this both
   discriminates insert vs. update *and* serializes concurrent upserts on
   the same key
6. If the probe found a row → evaluate the **update policy** against the
   live row. Denial is indistinguishable from a missing row, matching
   ordinary `.update(...)` semantics.
7. Execute `INSERT … ON CONFLICT (<pk>) DO UPDATE SET …` and read the
   resulting row back via `RETURNING`
8. **Enqueue the appropriate event** — `Created` if the probe saw no row,
   `Updated` otherwise — into the event outbox
9. **Enqueue the audit event** with the `before` snapshot from the probe
   (`None` on the insert branch) and the `after` snapshot from `RETURNING`
10. Commit, then drain the outbox

The extra round-trip for `SELECT … FOR UPDATE` is the price of clean
event / audit semantics without leaning on Postgres `xmax` — keeping the
rusqlite mirror trivial. Upsert is not a hot read path; callers who need
raw insert/update throughput should use `.create(...)` / `.update(...)`
directly.

### Policies: both must allow

Upsert evaluates **both** create and update policies at call time, before
the runtime knows which branch will actually fire. This is stricter than
"evaluate the path that runs," but it's the only choice we can make
without leaking row existence to the caller (pre-flighting a read just to
pick the policy slot would tell denied callers whether the row exists).

In practice this means:

1. write `@@allow(create, …)` and `@@allow(update, …)` so the intersection
   of permitted callers is exactly the set you want to be able to upsert
2. don't reach for `.upsert(...)` on models where create and update
   audiences are deliberately disjoint — that's a sign the operation
   wants to be split into separate create / update routes

### `@version` is bumped, but `if_match` isn't honored

Models with `@version` get the same monotonic guarantee as `.update(...)`:
the update branch emits `version = <table>.version + 1` in the same
statement, so concurrent upserts converge to a coherent version number.

`if_match` is **not supported** on upsert. The semantics — "update only if
version = N, otherwise insert" — is rarely what callers actually want; if
you really need that conditional, the right shape is an explicit
transaction with `find_unique` → `update.if_match(N)`. Adding `if_match`
to the upsert builder is on the deferred list and will require a clear
use case.

### Soft-deleted rows are not silently revived

Models with `@@soft_delete` treat tombstoned rows as "not present" for
the probe step. The INSERT branch then trips the primary-key uniqueness
constraint and the upsert fails — the framework refuses to silently
un-tombstone a row that an operator deleted. Callers who genuinely need
revive-on-upsert semantics should issue an explicit update that sets
`deleted_at = NULL`; we may add a `.revive_soft_deleted()` opt-in later
if a real use case appears.

### Auth-derived defaults are insert-only

Columns marked `@default(auth().*)` (e.g. `ownership_id` derived from the
caller's principal) are **excluded** from the DO UPDATE clause. They're
identity bindings, not column values; clobbering them on an update would
turn upsert into "take ownership of any row I name," which is exactly the
attack we're not interested in shipping.

The descriptor exposes the exact set of columns the update branch is
allowed to overwrite as `ModelDescriptor::upsert_update_columns`. Today
the rule is `scalar columns − {primary key, @version, @readonly,
@server_only, @default(...) }`.

## Embedded semantics

The on-device (`cratestack-rusqlite`) path is deliberately thinner:

1. no policy enforcement (the embedded backend is single-user and trusts
   its caller)
2. no transactional probe — the upsert is a single statement
3. no event outbox or audit log to discriminate

The SQL is a straightforward `INSERT … ON CONFLICT (<pk>) DO UPDATE SET …`
with the same `upsert_update_columns` rule, and `@version` is bumped via
`<table>.<col> + 1` so concurrent on-device writers converge. Use this
path when you're processing inbound sync messages from a server-of-truth
and want each message to be a self-describing convergence step.

## HTTP

Upsert is **ORM-only** at v1. There is no `PUT /<model>/<id>` route
generated today; that's deferred until the precondition story (`If-Match`,
`If-None-Match: *`) is wired through the upsert builder. The route shape
when it lands will be canonical REST:

```http
PUT /accounts/123 HTTP/1.1
If-None-Match: *           # require insert
Content-Type: application/json

{"balance": 100}
```

```http
PUT /accounts/123 HTTP/1.1
If-Match: "0"              # require update at version 0
Content-Type: application/json

{"balance": 100}
```

No `If-*` header → either branch is allowed, matching the current ORM
behavior. There is no `POST /<model>/upsert` and no verb-in-path
alternative; the conflict target lives in the URL.

## Comparison with idempotency

[`IdempotencyLayer`](./idempotency) and `.upsert(...)` solve complementary
problems and compose cleanly:

| | `IdempotencyLayer` | `.upsert(...)` |
|---|---|---|
| Layer | HTTP middleware | ORM primitive |
| Key | `Idempotency-Key` header | Model primary key |
| Replay | Returns captured response bytes | Re-executes against current row |
| Scope | One request, regardless of side effects | One row, regardless of request shape |
| Cost | Token reservation + response capture | One extra `SELECT FOR UPDATE` |

Use both when ingesting from a high-retry producer: the layer protects
against duplicate handler execution, the primitive protects against
duplicate rows even when two distinct requests carry the same payload.
