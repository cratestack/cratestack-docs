---
title: Audit Log
description: Transactional audit log for `@@audit` models, with PII redaction, before/after snapshots, and pluggable `AuditSink` fan-out.
---

# Audit Log

Banking workloads need a forensic trail: who touched what, when, with what
old and new state. CrateStack records audit rows **inside the same
transaction as the mutation they describe**, so you can never observe a
committed row whose audit entry didn't also commit.

## Schema attribute

Opt in per model:

```cstack
model Transfer {
  id Int @id
  amount Int
  status String
  notes String @sensitive
  customerEmail String @pii

  @@audit
  @@allow("create", auth() != null)
  @@allow("update", auth() != null)
  @@allow("delete", auth() != null)
}
```

Constraints enforced at parse time:

1. `@@audit` takes no arguments

Unlike `@@paged`, `@@emit`, and `@@id` — which do reject a duplicate
declaration at parse time — `@@audit` has no such check today. The
parser simply recognizes the attribute, and the macro descriptor detects
it with an `.any(...)` scan, so declaring `@@audit` twice on the same
model is silently a no-op rather than a validation error.

## What gets captured

For every `create`, `update`, and `delete` the runtime writes a row to
`cratestack_audit` containing:

1. a fresh `event_id` (UUID v4)
2. `schema_name` and `model` strings from the `.cstack`
3. `operation` — `create`, `update`, or `delete`
4. `primary_key` as JSON
5. `actor` derived from the `CratestackContext` — id, claims, optional source IP
   (see [Trusted Proxy / Client IP](./trusted-proxy) for how that IP is
   resolved, and the bootstrap step it's silently `None` without)
6. `tenant` from `PrincipalContext.tenant.id` when present
7. `before` snapshot (null on create) and `after` snapshot (null on delete)
8. `request_id` for trace stitching
9. `occurred_at` timestamp

## PII redaction

Field attributes participate in the snapshot serializer:

1. `@pii` — value replaced with `"<redacted: pii>"` in `before`/`after`
2. `@sensitive` — value replaced with `"<redacted: sensitive>"`
3. `@server_only` — field omitted entirely from the snapshot

The redaction happens before the audit row is written. Re-replaying the
JSON later can never recover the redacted value, even with the SQL audit
table in hand. Banks complying with GDPR / PCI-DSS use `@pii` for emails,
phone numbers, and tokenized PANs; `@sensitive` covers internal risk
scores, dispute notes, and operator commentary.

## Transactional guarantee

The audit insert participates in the mutation's transaction. The flow is:

1. begin transaction
2. apply the mutation
3. capture `after` (and `before` for update/delete)
4. insert into `cratestack_audit`
5. commit

A rollback in step 2 or 4 rolls back both. Banks treat this as a contract:
no audit row without a row, no row without an audit row.

## Fan-out to downstream sinks

The in-database table is canonical. Downstream consumers (Kafka topics,
SIEM, S3 archives, HTTP webhooks) implement `AuditSink`:

```rust
use cratestack::AuditSink;

#[derive(Clone)]
struct KafkaAuditSink { /* ... */ }

#[async_trait::async_trait]
impl AuditSink for KafkaAuditSink {
    async fn record(&self, event: &cratestack::AuditEvent) -> Result<(), cratestack::CratestackError> {
        // publish to your topic; errors are surfaced to MulticastAuditSink
        Ok(())
    }
}
```

Compose multiple sinks with `MulticastAuditSink`:

```rust
let sinks = MulticastAuditSink::new(vec![
    Arc::new(KafkaAuditSink::new(/* ... */)),
    Arc::new(S3ArchiveSink::new(/* ... */)),
]);
```

A single sink failure surfaces as `CratestackError::Internal` rather than
silently swallowing — `MulticastAuditSink` still calls every sink in the
list even after an earlier one fails, then aggregates all the errors
into that one `CratestackError::Internal`, so one bad downstream doesn't stop
the others from receiving the event. Banks treat downstream errors as
alertable, not fire-and-forget. The default sink is `NoopAuditSink`; the
table is the source of truth even without one.

### Installing a sink

Implementing `AuditSink` isn't enough by itself — it has to be attached to
the runtime with `with_audit_sink`, the same builder-method shape
`IdempotencyStore`/`RateLimitStore` use elsewhere:

```rust
let cool = cratestack_schema::Cratestack::builder(pool)
    .with_audit_sink(Arc::new(sinks)) // the MulticastAuditSink from above
    .build();
```

Without this call the runtime keeps its default `NoopAuditSink`, and
`AuditSink::record` is never invoked at all — the `cratestack_audit` table
still gets every row (that insert is unconditional on `@@audit` models),
only the downstream fan-out is skipped.

### `.run_in_tx(...)` and `db.transaction(...)` writes: fan-out is opt-in, not automatic

Every generated ORM write path dispatches the installed `AuditSink` itself,
*after* its own transaction commits — `.create(...).run(ctx)`,
`.update(...).run(ctx)`, the `batch_*` primitives, all of them. The one
exception is the composable `.run_in_tx(&mut tx, ctx)` variant that lets a
caller chain several model writes inside one hand-managed transaction (see
[Transaction isolation](./transaction-isolation)): it still writes the
`cratestack_audit` row inside `tx`, but it does **not** call the sink on its
own, because it hands the transaction back to the caller uncommitted and has
no reliable way to know whether — or when — that transaction actually
commits. The same is true of `db.transaction(...)`, the newer combinator
that composes several `run_in_tx` calls without naming a `sqlx` type: its
closure body is arbitrary caller code, so the combinator has no way to
discover which audit events that body produced, and cannot dispatch them
either.

This was a real, unaddressed gap for a while (cratestack#534) — a `run_in_tx`
caller had no way to opt in at all, since `dispatch_audit_sink` wasn't even
public and `run_in_tx` didn't hand back the built `AuditEvent`. **It is now
a real, working, but still manual opt-in.** Every `run_in_tx` variant
returns a `RunInTxOutcome<T>` carrying the `AuditEvent`(s) it built and
already persisted (`.value` for what `.run(...)` would have returned,
`.audit_events` for the events); collect those across every write in your
transaction and call the generated `Cratestack::dispatch_audit_sink` once,
after your own `tx.commit()` succeeds (or after `db.transaction(...)`
returns `Ok`, threading the collected events out through your own closure's
return value — the combinator can't collect them for you):

```rust
let mut tx = pool.begin().await?;
let mut audit_events = Vec::new();

let revoked = cool.account().update(id).set(patch).run_in_tx(&mut tx, &ctx).await?;
audit_events.extend(revoked.audit_events);

let created = cool.account().create(input).run_in_tx(&mut tx, &ctx).await?;
audit_events.extend(created.audit_events);

tx.commit().await?;
// Only now — never before commit, never automatically — does the sink see anything:
cool.dispatch_audit_sink(&audit_events).await;
```

Forgetting this call is exactly as silent as the gap used to be
unconditionally: `cratestack_audit` still gets every row (that insert is
unconditional on `@@audit` models), the installed sink just never hears
about it for that transaction. If your compliance posture depends on the
downstream sink firing for every audited write, treat this call as
mandatory wherever you compose writes through `.run_in_tx(...)` or
`db.transaction(...)` — there is no way for the framework to enforce that
you remembered it. The identical opt-in exists for `@@emit` subscribers via
the pre-existing `Cratestack::events().drain()` — it re-scans the outbox for
undelivered rows rather than needing a specific event handed back, so it
was already usable this way; call it the same way, after your own commit.

## Schema

```sql
CREATE TABLE cratestack_audit (
    event_id UUID PRIMARY KEY,
    schema_name TEXT NOT NULL,
    model TEXT NOT NULL,
    operation TEXT NOT NULL,
    primary_key JSONB NOT NULL,
    actor JSONB NOT NULL,
    tenant TEXT,
    before JSONB,
    after JSONB,
    request_id TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    delivered_at TIMESTAMPTZ,
    attempts BIGINT NOT NULL DEFAULT 0,
    last_error TEXT
);
```

Indexes are created for `(schema_name, model, occurred_at DESC)`,
`(tenant, occurred_at DESC)`, and undelivered rows.

The DDL is exposed as `cratestack::AUDIT_TABLE_DDL`. Banks running their
own migration tooling embed it; the `SqlxRuntime` calls it idempotently
during bootstrap.

## Retention

The framework does not delete from `cratestack_audit`. Banks running
regulatory retention (5 / 7 / 10 years depending on jurisdiction) move old
rows to cold storage and prune the live table via their own tooling. The
schema is index-friendly for time-window deletes.

## What this is not

1. not a tamper-evident chain — no per-row cryptographic signature
2. not WORM storage — anyone with `DELETE` on the table can rewrite history
3. not a substitute for application-level event sourcing

Banks needing tamper evidence sink to a WORM bucket or signed log;
`MulticastAuditSink` is the integration seam.

## Read Next

1. [Field attributes](../reference/field-attributes) for `@pii`, `@sensitive`, `@server_only`
2. [Transaction isolation](./transaction-isolation) for the transactional model the audit insert participates in
3. [Trusted Proxy / Client IP](./trusted-proxy) for how `actor.ip` gets populated behind a reverse proxy
