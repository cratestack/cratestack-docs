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
specific row without leaking server identity to the caller.

By default the conflict target is the model's primary key, but it isn't
the only option: `.on_conflict(ConflictTarget::Columns(&["col1",
"col2"]))` lets the upsert target any column tuple backed by a `UNIQUE`
constraint or index — including a [composite `@@unique([...])`](../reference/composite-keys)
constraint. This is a real, currently-working mechanism (`ConflictTarget::{PrimaryKey, Columns}`),
available on both the server (`cratestack-sqlx`) upsert builder and the
embedded (`cratestack-rusqlite`) upsert builder symmetrically:

```rust
// Upsert on a composite unique key instead of the primary key.
let setting = cool
    .ownerSetting()
    .upsert(CreateOwnerSettingInput { owner_id, provider, value })
    .on_conflict(ConflictTarget::columns(&["owner_id", "provider"]))
    .run(&ctx)
    .await?;
```

Named columns must correspond to a `UNIQUE` constraint/index on the
target table — the database enforces this and surfaces a clear error if
not — and the input must carry a value for every column in the target
tuple, since the conflict probe (`SELECT … FOR UPDATE`) filters on it.
Composite-constraint-by-name (`ON CONFLICT ON CONSTRAINT my_unique_idx`)
isn't exposed; pass the matching column tuple via `ConflictTarget::Columns`
instead.

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

### `.do_nothing()`: converge without overwriting

`.upsert(input).run(ctx)` above always does `ON CONFLICT DO UPDATE` — a conflicting row gets
overwritten with the new input's values. That's wrong for the idempotent-ingestion case this guide
opens on whenever the retry's payload is *incomplete*, not a full re-statement of the desired row: a
cash-in claim that inserts a `PENDING` row and treats a conflict as "already in flight" must never let
a retry's blank values overwrite a row a downstream process has since moved to `COMPLETED`.
`.do_nothing()` (`crates/cratestack-sqlx/src/query/write/upsert.rs`, cratestack#487) switches the
conflict branch to a real `ON CONFLICT DO NOTHING` — the existing row is returned completely
untouched, not merged:

```rust
use cratestack::UpsertOutcome;

let outcome: UpsertOutcome<CashInClaim> = cool
    .cashInClaim()
    .upsert(CreateCashInClaimInput { id: idempotency_key, status: Status::Pending, amount })
    .do_nothing()
    .run(&ctx)
    .await?;

match outcome {
    UpsertOutcome::Inserted(claim) => {
        // First time we've seen this key — proceed with the cash-in.
    }
    UpsertOutcome::Existing(claim) => {
        // Already in flight (or already COMPLETED) — the stored row is
        // untouched, so a retry can never blank out `claim.status`.
    }
}
```

`.do_nothing()` returns a distinct builder (`UpsertRecordDoNothing`), because the return type
genuinely changes: a real `DO NOTHING` returns nothing at all for the conflicting row (Postgres only
`RETURNING`s rows a statement actually touched), so `Result<M, CratestackError>` can't express
"inserted vs. already there" — `Result<UpsertOutcome<M>, CratestackError>` can.
`UpsertOutcome<M>::{Inserted(M), Existing(M)}` exposes `.was_inserted() -> bool` and
`.into_record() -> M`/`.record() -> &M` for callers that only need the row. `.on_conflict(...)` chains
the same way as the plain path, before or after `.do_nothing()`. This is purely additive — existing
`.upsert(...).run(...)` call sites keep their current `Result<M, CratestackError>` signature and DO
UPDATE behavior unchanged.

**Server-only.** `.do_nothing()` exists on `cratestack-sqlx`'s builder; there is no
`cratestack-rusqlite` (embedded) equivalent — see [Embedded semantics](#embedded-semantics) below.

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
   predicts insert vs. update *and* serializes concurrent upserts on
   the same key
6. If the probe found a row → evaluate the **update policy** against the
   live row, capture the `before` snapshot, and run `DO UPDATE`. Denial is
   indistinguishable from a missing row, matching ordinary `.update(...)`
   semantics.
7. If the probe found **no** row → execute
   `INSERT … ON CONFLICT (<target>) DO NOTHING RETURNING …`, so the
   database itself answers "did I actually insert?"
8. **A returned row means a genuine insert** — `Created`,
   `AuditOperation::Create`, no `before` snapshot, one statement, no extra
   round trip
9. **No returned row means the probe lost a race**, and the winning row
   has not been touched yet. The runtime re-enters the update branch from
   the top, re-running the same probe — which blocks until the winning
   transaction commits, so it reads that transaction's final data:
   - **Re-probe finds the winner** (the ordinary case) → run the update
     policy gate, capture a real `before` snapshot, then `DO UPDATE`.
     Outcome is `Updated` / `AuditOperation::Update` with the winner's
     row as `before`
   - **Re-probe still finds nothing** → the conflict is real but
     invisible to the probe. `DO UPDATE` runs **without** the update
     policy gate and the outcome is reported as `Inserted` / `Created`
     with no `before`. Two causes: the winning row was deleted again
     between the two statements (in which case the statement really did
     insert, and `Inserted` is correct), or a soft-delete tombstone sits
     at the conflict target — see
     [below](#soft-deleted-rows-and-the-two-paths), where that second
     case is a known defect rather than the correct answer
10. **Enqueue the event and the audit entry** reflecting what the database
    actually did, then commit and drain the outbox

<Note>
**Why the database decides, not the probe** ([#745](https://github.com/cratestack/cratestack/issues/745)).
Before 0.8.14 the Created-vs-Updated decision came from the pre-statement
probe and was never reconciled against what actually happened. When a
concurrent transaction committed a conflicting row in the gap, Postgres
serialized on the unique index and performed a genuine **UPDATE** — but
the runtime still emitted a `Created` event and wrote
`AuditOperation::Create` with a `null` before-snapshot, and skipped the
update-policy gate entirely. The returned row was correct; the audit
trail and event stream described something that never happened.

Nothing changed off the race path: the uncontended insert and the
probe-predicted update emit exactly what they always did, and
`UpsertOutcome`'s public shape is unchanged.

This is deliberately **not** implemented with `RETURNING (xmax = 0)`,
which classifies correctly but only *after* the prior row has been
overwritten and is unrecoverable — and is a Postgres storage detail with
no counterpart elsewhere, where `ON CONFLICT DO NOTHING … RETURNING` is
documented behaviour SQLite mirrors verbatim.
</Note>

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

### `.do_nothing()`'s policy, event, and concurrency contract

`.do_nothing()` reuses the same `SELECT … FOR UPDATE` probe as the DO UPDATE path — the row lock is
what makes "return what the probe found, untouched" safe without a second statement:

1. **Create policy still gates the insert branch unconditionally**, same as `.create()` and the DO
   UPDATE path — `.do_nothing()` still performs a real `INSERT` when no conflicting row exists.
2. **The update policy is still evaluated against an existing row, even though it's never mutated.**
   Skipping this check would let a caller with only create authorization use `.do_nothing()` to probe
   for a row's existence and read its current contents — exactly the leak the DO UPDATE path's
   "both policies must allow" rule already exists to close (see
   [Policies: both must allow](#policies-both-must-allow) above). Denial surfaces the identical
   `"update policy denied this upsert"` error either way.
3. **Only the `Inserted` branch emits anything.** A `Created` event and audit entry fire exactly like
   `.create(...)`'s. `Existing` emits neither — the row genuinely didn't change, so there's nothing to
   record.
4. **The insert branch races honestly, not naively.** The probe finding no row doesn't itself lock
   anything, so a concurrent transaction can still commit a conflicting row in the gap before this
   transaction's own `INSERT … ON CONFLICT DO NOTHING` runs. When that race is lost, the runtime
   performs one more locked read and hands back the winning transaction's row as `Existing` — never a
   phantom `Existing` built from stale data. In the doubly-unlikely case that *that* row is deleted
   before the fallback read completes, the call returns `CratestackError::Conflict` rather than
   inventing a result; retry the call.

### Soft-deleted rows and the two paths

Models with `@@soft_delete` treat tombstoned rows as "not present" for
the probe step, and the two upsert paths diverge from there.

<Warning>
**The `DO UPDATE` path revives a tombstone and reports it as a create.**
Because `select_for_update_by_conflict_target` deliberately treats a
tombstone as "no row", a tombstone at the conflict target is invisible to
**both** probes — the initial one and the re-probe in step 9 — so the
`DO UPDATE` un-deletes that row and returns `UpsertOutcome::Inserted`,
with a `Created` event and `AuditOperation::Create`. This is the second
bullet of step 9: `before` is `None`, so the runtime reports an insert
and the update policy gate does not run. This is a known defect, recorded in
`upsert_resolve.rs` at the branch where it surfaces. It was explicitly
left alone by [#745](https://github.com/cratestack/cratestack/issues/745),
whose fix was scoped to the race path only; correcting it here would
change behaviour off that path.

`.do_nothing()` does **not** share the defect — it surfaces a `Conflict`
for the same shape.

If a model uses `@@soft_delete` and you upsert on a conflict target that
tombstones can occupy, don't rely on the outcome flag to mean "this row
is new". Issue an explicit update setting `deleted_at = NULL` when you
genuinely want revive-on-upsert semantics.
</Warning>

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

The SQL is a straightforward `INSERT … ON CONFLICT (<pk-or-columns>) DO
UPDATE SET …` with the same `upsert_update_columns` rule, and `@version`
is bumped via `<table>.<col> + 1` so concurrent on-device writers
converge. `.on_conflict(ConflictTarget::Columns(&[...]))` works here too
— composite-key upsert isn't a server-only capability, it's available on
the embedded delegate symmetrically. Use this path when you're processing
inbound sync messages from a server-of-truth and want each message to be
a self-describing convergence step.

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
