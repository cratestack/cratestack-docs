---
title: Prepared Statements and Query Caching
description: Whether Postgres queries go through prepared statements, whether CrateStack caches query results, and the knobs a consumer owns for both.
---

# Prepared Statements and Query Caching

Two questions come up together often enough to answer in one place: does
CrateStack prepare its Postgres statements, and does it cache query
results? Short version — prepared statements, yes, automatically, with no
framework configuration involved. Query-result caching, no, not on the
server; what looks like caching elsewhere (client-side SWR, offline state
stores) is a different mechanism solving a different problem.

## Prepared statements: automatic, via sqlx

CrateStack's Postgres renderer never interpolates values into SQL text.
`PostgresDialect::write_placeholder` writes numbered `$N` binds
(`crates/cratestack-sql/src/dialect.rs`), and every execution path —
generated CRUD, the audit log, `find_many` — runs the resulting SQL
through `sqlx::query(...).bind(...)` or `sqlx::QueryBuilder` with
`push_bind`, never string formatting. See
`crates/cratestack-sqlx/src/audit.rs` for a representative example, or
`crates/cratestack-sqlx/src/query/read/find_many.rs` for the
`QueryBuilder` path `find_many` takes at execution time.

Nothing in the workspace calls sqlx's `.persistent(false)` escape hatch,
so every query goes through sqlx's normal path: the extended query
protocol, with Postgres genuinely preparing each statement and sqlx
(pinned at 0.8.6 in `Cargo.lock`) caching the prepared handle per
connection, keyed by SQL text. You get this for free — there's no
`@@prepared` attribute or config flag to turn on.

### The pool is yours to tune

`SqlxRuntime::new(pool: sqlx::PgPool)` (`crates/cratestack-sqlx/src/descriptor.rs`)
takes a pool the consumer constructs. The `cratestack-sqlx` runtime itself
doesn't build one for you and doesn't override connect options, so
everything sqlx exposes on the pool and connection —
`statement_cache_capacity`, `max_connections`, TLS mode, and so on — is
yours to set:

```rust
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

let options: PgConnectOptions = std::env::var("DATABASE_URL")?.parse()?;
let pool = PgPoolOptions::new()
    .max_connections(20)
    .connect_with(options)
    .await?;
```

The default statement-cache capacity is 100 distinct statements per
connection, LRU-evicted — that's sqlx's default, not something CrateStack
changes.

**Exception:** if you're using `cratestack-service` (the env-driven
service-bootstrap facade), it builds the pool for you —
`ServiceConfig::state()` (`crates/cratestack-service/src/config.rs:130-139`)
opens a lazily-connecting pool via `PgPoolOptions::new().max_connections(5).connect_lazy_with(options)`,
and `run_migrations()` (`crates/cratestack-service/src/migrations.rs:66-73`)
opens a separate one-off, single-connection pool
(`PgPoolOptions::new().max_connections(1).connect(database_url)`) purely to
apply migrations at startup. Neither call site sets
`statement_cache_capacity`, so both get sqlx's default of 100 — if you're
on this facade and need to change it (e.g. the PgBouncer case below),
that's the place to do it; there's no config knob exposed through
`ServiceConfig` itself today.

### SQLite uses the same binding discipline, without the same cache

`SqliteDialect::write_placeholder` writes `?N`, and the embedded backend
(`crates/cratestack-rusqlite`) binds every value through rusqlite's
parameter API rather than formatting it into the SQL string — same
injection-safety guarantee as the Postgres path. But the reasoning about
*caching* doesn't carry over: every delegate (`find_many`, `find_unique`,
`aggregate_count`, …) calls `conn.prepare(&sql)` fresh on each invocation,
not rusqlite's `prepare_cached`. There's no cross-call statement reuse in
the embedded backend today — each call compiles its statement, runs it,
and drops it. SQLite's own query compilation is cheap enough that this
generally doesn't matter in practice, but if you're chasing embedded-path
latency, know that there's no LRU cache to tune here the way there is on
the Postgres side.

## Query caching: no, not on the server

There is no query-result cache anywhere in `cratestack-sqlx` or
`cratestack-core` — every `run()`/`run_in_tx()` call hits Postgres. Two
things in the framework are easy to mistake for query caching; neither is:

**Idempotency is response replay, not query caching.** `IdempotencyLayer`
stores the full captured HTTP response (status, headers, body) keyed by
`(principal, idempotency key, request hash)` and replays it verbatim for
a retried request — see
[Idempotency](./idempotency) for the full state machine. That's caching a
*response*, at the request boundary, for a specific opt-in header. It
never touches the query layer and does nothing for a request that doesn't
send `Idempotency-Key`.

**Principal fingerprinting fails closed, not into a shared bucket.** If
you're evaluating idempotency defaults: the default principal fingerprint
(`crates/cratestack-axum/src/idempotency/layer.rs`) tries the
`Authorization` header first, then the verified `ConnectInfo<SocketAddr>`
peer (requires serving through
`into_make_service_with_connect_info::<SocketAddr>()`). If **neither** is
available, it refuses the request with `412 Precondition Failed`
(`CratestackError::PreconditionFailed`) rather than collapsing every such caller
onto a shared `"anonymous"` namespace — an earlier version of the default
did exactly that, and the doc comments in that file narrate the old
behavior for context, which reads confusingly out of context: the
fail-closed refusal is what actually runs. The rate-limit layer's
`default_key_fn` (`crates/cratestack-axum/src/ratelimit/layer.rs`) mirrors
this. Wire `into_make_service_with_connect_info`, or supply
`with_principal_fingerprint`/`with_key_fn` explicitly, to avoid the 412 —
see [Idempotency § Principal scoping](./idempotency#principal-scoping).

**Client-side caching is real, but it's a different layer.** The
TypeScript client's `--swr` layout gives you genuine
stale-while-revalidate response caching in the browser: generated hooks
key on the query/filter arguments via `swrKeys`, and generated mutation
hooks invalidate the affected list/detail keys automatically. That's
useful and worth knowing about, but it's browser-side HTTP response
caching, not anything the server does — see the generated `swr/` module
in `cratestack-client-typescript` if you're using that preset.

`cratestack-client-store-sqlite` and `cratestack-client-store-redis`
implement `ClientStateStore` for offline-first Rust clients. They persist
a `PersistedClientState` (schema/state version plus a `request_journal:
Vec<RequestJournalEntry>`) where each `RequestJournalEntry` records
method, path, status code, content type, and timestamp — a journal of
*what requests were made*, for offline replay/sync bookkeeping. It does
not store response bodies or query results, so it isn't a cache in the
query-caching sense either.

## Where cache-hit rate actually depends on you

Prepared-statement caching only helps when the same SQL text recurs.
Two shapes behave very differently:

**Fixed-shape CRUD is stable.** `create`, and `update`/`delete` by
primary key, always produce the same SQL string for a given model — the
column list and WHERE clause don't change based on request content. These
hit the connection's statement cache every time after the first call.

**`find_many` is not.** Its `WHERE`/`ORDER BY`/`LIMIT`/`OFFSET` clauses
are assembled per call from whichever filters and sort clauses the caller
actually supplied (`crates/cratestack-sqlx/src/query/read/find_many.rs`
builds the query via `sqlx::QueryBuilder`, appending only the pieces
present on that particular request). Two calls to the same generated
`find_many` with different filter combinations produce two different SQL
strings — and therefore two different cache entries. A model with a wide,
mostly-optional filter surface (`FindMany<Model>` — see
[Search with Filters](./find-many)) can rack up far more distinct
statement shapes than a fixed-shape route, and can churn a connection's
100-entry LRU cache under enough combinatorial variety. If you're
Postgres-CPU-bound on a heavily-filtered list endpoint, this is the first
place to look, not the statement cache's existence — the fix is usually
either raising `statement_cache_capacity` or narrowing the filter surface
exposed to callers.

## Operating behind PgBouncer

Prepared statements assume the same server-side connection persists
across your session — true of a normal `PgPool` connection, **not** true
of PgBouncer in transaction-pooling mode, which can hand a client's next
statement to a different backend connection than the one that prepared
it. This paragraph is external PgBouncer behavior, not something
verified against CrateStack's own code — confirmed instead against
PgBouncer's own [changelog](https://www.pgbouncer.org/changelog.html)
and [`max_prepared_statements` config docs](https://www.pgbouncer.org/config.html).
PgBouncer ≥ 1.21.0 (October 2023) can track and re-prepare statements
per client across transaction-pooling connections when
`max_prepared_statements` is non-zero — and as of PgBouncer 1.24.0
(January 2025) that's the out-of-the-box default (200), so a current
PgBouncer needs no extra config for prepared statements to keep
working. Only if you're on PgBouncer < 1.21.0, or have
`max_prepared_statements` explicitly set to `0`, do you need to disable
sqlx's client-side statement cache on your own connect options instead:

```rust
use sqlx::postgres::PgConnectOptions;

let options = PgConnectOptions::new()
    .statement_cache_capacity(0);
    // ...host/user/etc.
```

Because the pool is entirely yours to construct (see above), this needs
no framework change — it's a connect-option flag you set once. Session
and statement pooling modes don't have this problem; only transaction
pooling does.

## Debugging what SQL a call will run

`preview_sql()` — available on `find_many`, `find_unique`, `create`,
`update`, `delete`, and friends under `crates/cratestack-sqlx/src/query/`
and `delegate/` — renders the SQL string a call *would* execute, with
placeholders numbered but never bound and never sent to the database.
It's a pure string builder for the studio's "show me the query" pane and
for local debugging; calling it does not touch the connection pool, and
it tells you nothing about whether that statement is already in a given
connection's prepared-statement cache.

## What this is not

1. **not a caching layer you configure in `.cstack`** — there's no
   `@@cache` attribute; everything here is either sqlx's default behavior
   or a plain `PgConnectOptions` call on a pool you already own.
2. **not free performance on a wide filter surface** — a heavily
   parameterized `find_many`/`FindMany<Model>` endpoint pays for its
   flexibility in cache-entry variety, not just planning time.
3. **not a substitute for `EXPLAIN ANALYZE`** — `preview_sql()` shows you
   the SQL shape, not a query plan or execution cost.

## Read Next

1. [Idempotency](./idempotency) — response replay at the request boundary, and current principal-fingerprint fallback behavior
2. [Search with Filters — `FindMany<Model>`](./find-many) — the typed filter surface whose combinatorics drive statement-cache variety
3. [TypeScript Client Generation](./typescript-client-generation) — the `--swr` layout's browser-side response caching
