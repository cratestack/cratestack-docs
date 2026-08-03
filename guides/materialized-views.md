---
title: Materialized views
description: When to use @@materialized, and the four refresh trigger patterns CrateStack expects developers to implement on their own.
---

# Materialized views

A materialized view stores the result of its `SELECT` as physical rows and serves reads from that cache. Subsequent reads are table-fast, but the cache only reflects source data as of the last **refresh**.

CrateStack supports materialized views on the server (Postgres) backend via `@@materialized`. They are not supported on the embedded (SQLite) backend — building such a schema for the embedded target is a hard compile error referencing [ADR 0003](../internals/views-adr).

For the full syntax reference, see [Views](../reference/views). This guide is about **when to use materialization** and **how to refresh**.

## Schema declaration

```cstack
view AccountBalance from Account, Transfer {
  accountId Uuid     @id  @from(Account.id)
  balance   Decimal

  @@materialized
  @@server_sql("""
    SELECT a.id AS account_id,
           a.opening_balance
           + COALESCE(SUM(t.amount), 0) AS balance
    FROM   account a
    LEFT JOIN transfer t ON t.account_id = a.id
    GROUP  BY a.id, a.opening_balance
  """)

  @@allow("read", auth().id == accountId)
}
```

`@@materialized` marks the view as a Postgres materialized view rather than a plain saved query. It requires:

* **`@@server_sql` or `@@sql`** — either satisfies the SQL-body requirement. When no `@@server_sql` is present, the view falls back to the portable `@@sql` shorthand for its server-side body, so `@@materialized` paired with only `@@sql` is supported, not rejected.
* **`@id`** on exactly one field — `@@no_unique` is rejected for materialized views, since concurrent refresh needs a unique index to refresh against.

The `cratestack migrate diff` CLI (the `cratestack-migrate` crate) emits `CREATE MATERIALIZED VIEW` plus a backing `CREATE UNIQUE INDEX` during migration generation; the macro's own job stops at generating the Rust struct, descriptor, and the `refresh()` accessor used throughout the rest of this guide. `@@materialized` is server-only — building an embedded target with one in scope is a hard compile error referencing [ADR 0003](../internals/views-adr).

## When materialization is the right tool

Reach for `@@materialized` when **all** of the following are true:

1. The view's `SELECT` is expensive — aggregations over large tables, multi-way joins, window functions over event streams.
2. The freshness requirement is **measured in seconds or minutes**, not milliseconds. Reads can tolerate staleness up to your chosen refresh cadence.
3. The source data changes at a **lower rate than the read rate**. Materialization is a cache; cache hit ratio has to be favorable.
4. The view's read traffic is **high enough that the saved query cost outweighs the refresh cost**. A view read three times a day is not worth materializing.

If any of these fails, prefer a regular `view`. A regular view is just a saved query — its cost is identical to running the underlying `SELECT` each time, with zero staleness and zero refresh cost.

## Refresh is manual, by design

CrateStack does **not** provide automatic refresh — no scheduler, no time-based refresh, no event-driven refresh wired to model writes. This is deliberate ([ADR 0003](../internals/views-adr#deferred)): automatic refresh forces consistency tradeoffs into the framework that belong in the application, and the framework cannot know which tradeoff is correct for your workload.

The developer calls `refresh()` explicitly:

```rust
runtime.views().account_balance().refresh().await?;
```

This emits `REFRESH MATERIALIZED VIEW CONCURRENTLY <name>`. Concurrent refresh requires a unique index on the view, which is why `@id` is required for materialized views — the migrate CLI emits the unique index automatically alongside the view DDL.

## Refresh trigger patterns

The four patterns developers commonly implement. Pick the one that matches your freshness requirement and write the trigger code yourself.

### 1. Scheduled (cron / job runner)

The most common pattern. A background job invokes `refresh()` on a fixed cadence.

```rust
// In your job runner (tokio-cron-scheduler, cron crate, k8s CronJob, etc.)
async fn refresh_account_balances(runtime: Arc<Runtime>) -> anyhow::Result<()> {
    runtime.views().account_balance().refresh().await?;
    Ok(())
}
```

**Use when:** freshness requirement is "stale by at most N minutes". Set the cadence below N.

**Watch out for:** refresh overlap. If a refresh takes longer than the cadence, two refreshes run concurrently and `REFRESH … CONCURRENTLY` queues. Use a job-runner lock or an in-process `tokio::sync::Mutex` to skip overlapping runs.

### 2. On-demand from a procedure

Refresh as part of the operation that depends on fresh data. The user clicks "recompute balances"; the procedure refreshes the view before returning the new data.

```rust
async fn recompute_balances(ctx: &ProcedureCtx) -> Result<AccountBalanceList> {
    ctx.runtime().views().account_balance().refresh().await?;
    ctx.runtime().views().account_balance().find_many().run(ctx.context()).await
}
```

**Use when:** freshness is user-driven and the user is willing to wait for the refresh latency. Good for dashboards with a "refresh" button.

**Watch out for:** users who hammer the button. Wrap in a per-user rate limiter ([rate limiting](./rate-limiting)).

### 3. Event-debounced

Subscribe to `ModelEvent` for the source models. Coalesce events over a short window, then refresh once.

```rust
async fn refresh_on_transfer_events(
    runtime: Arc<Runtime>,
    mut events: impl Stream<Item = ModelEvent<Transfer>> + Unpin,
) -> anyhow::Result<()> {
    let mut pending = false;
    let mut ticker = tokio::time::interval(Duration::from_secs(30));

    loop {
        tokio::select! {
            Some(_) = events.next() => { pending = true; }
            _ = ticker.tick(), if pending => {
                runtime.views().account_balance().refresh().await?;
                pending = false;
            }
        }
    }
}
```

**Use when:** source data changes in bursts and freshness should follow activity, not wall-clock time. Quieter periods refresh less often.

**Watch out for:** a steady-state stream of events refreshing every tick. The debounce window is the **floor on staleness**, not a guarantee — pick it deliberately.

### 4. Write-coupled (don't, usually)

Refresh inline at the end of every source-model write. This is the pattern you should almost always reject — it makes every write pay the refresh cost, defeats the whole point of materialization for write-heavy workloads, and turns short transactions into long ones.

It is only correct when source writes are **rare** and reads require **immediate freshness**. In that case, a regular view is usually cheaper than a materialized one + write-coupled refresh.

## Refresh duration and observability

`REFRESH MATERIALIZED VIEW CONCURRENTLY` time scales with the **size of the rebuilt result set**, not the size of the source tables. A view with 10k output rows refreshes in roughly the time it takes Postgres to re-run the underlying `SELECT` and compute the diff against the existing rows.

Instrument it:

```rust
let start = Instant::now();
runtime.views().account_balance().refresh().await?;
metrics::histogram!("view.refresh.duration",
    start.elapsed(), "view" => "account_balance");
```

Refresh duration drift is a leading indicator of source-table growth. Track it.

## Failure handling

`refresh()` returns `Result<()>`. On failure (deadlock, source-table lock, disk pressure), the existing materialized view contents are **unchanged** — reads continue to serve the previous snapshot. This is a useful property: a failed refresh degrades to staleness, not unavailability.

Log refresh failures; don't propagate them to user-facing responses unless freshness is part of the user's request (pattern 2). Background refreshers (patterns 1 and 3) should retry with backoff.

## What materialized views are not

* **Not a replication target.** They live in the same Postgres instance as the source tables. Refresh contention is real.
* **Not a CQRS read model.** They are SQL-defined and Postgres-managed; CQRS read models are separately-persisted, app-managed, and updated via events. Both are valid; they solve different problems.
* **Not a write target.** No `insert`, `update`, or `delete` methods on the delegate — enforced at the type level.
* **Not portable to embedded.** `@@materialized` is server-only. See [ADR 0003](../internals/views-adr#materialized-views).

## Read Next

1. [Views reference](../reference/views) — full syntax for `view` and `@@materialized`
2. [Telemetry](./telemetry) — wiring `refresh()` durations into your metrics pipeline
3. [Rate limiting](./rate-limiting) — for pattern 2 (user-triggered refresh)
