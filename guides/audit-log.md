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
5. `actor` derived from the `CoolContext` — id, claims, optional source IP
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
    async fn record(&self, event: &cratestack::AuditEvent) -> Result<(), cratestack::CoolError> {
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

A single sink failure surfaces as `CoolError::Internal` rather than
silently swallowing — banks treat downstream errors as alertable, not
fire-and-forget. The default sink is `NoopAuditSink`; the table is the
source of truth even without one.

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
