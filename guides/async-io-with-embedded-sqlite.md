---
title: Async I/O with Embedded SQLite
description: Run cratestack-rusqlite's sync ModelDelegate from inside a tokio-based server or daemon — the spawn_blocking seam, in detail.
---

# Async I/O with Embedded SQLite

[`cratestack-rusqlite`](/guides/offline-first-sqlite) is intentionally **synchronous** — its `ModelDelegate` API does not return futures, the runtime holds a `Mutex<Connection>`, and SQL calls block the calling thread. That's the right shape for mobile and desktop apps, where the UI layer drives a Rust core over FFI and there's no async runtime in the picture.

It becomes a question the moment you wrap the embedded backend in an `axum` server, a `notify`-driven daemon, or any other tokio-shaped process: **how do you call sync persistence code from an async handler without stalling the tokio worker pool?**

This guide is the answer.

## When this applies

You need the pattern in this guide if all three of the following are true:

1. You're using `cratestack-rusqlite` (i.e. `include_embedded_schema!`) rather than `include_server_schema!` + Postgres.
2. Your host process is async — a `#[tokio::main]` binary, an `axum`-served HTTP server, a long-running daemon driven by `tokio::select!`, etc.
3. You're using tokio's **multi-threaded** runtime (the default for `#[tokio::main]`). On the current-thread runtime the seam still exists but the cost of getting it wrong is smaller.

If your process is a CLI, a FFI cdylib called from Flutter, or a wasm module hosted by a browser, you do **not** need this guide — the calling thread already is, or fakes being, sync.

## What can go wrong

The naive shape is to call the delegate directly from an async handler:

```rust
// ⚠️ DON'T — blocks the tokio worker for the duration of the SQL
async fn create_note(State(state): State<AppState>, Json(input): Json<NewNote>)
    -> Result<Json<NoteView>, AppError>
{
    let notes = ModelDelegate::new(&state.runtime, &cratestack_schema::NOTE_MODEL);
    let row = notes.create(input.into()).run()?;     // ← synchronous I/O
    Ok(Json(row.into()))
}
```

Tokio's multi-threaded scheduler runs a small fixed pool of worker threads (defaulting to one per CPU core). Every async handler runs on one of those workers. When a handler calls `notes.create(...).run()?`, the worker is **pinned** inside that synchronous call for as long as SQLite takes to acquire the mutex, write the row, optionally fsync, and update the WAL. None of the other tasks scheduled on that worker make progress in the meantime.

For WAL-mode SQLite on NVMe with no contention this is sub-millisecond and probably fine. As soon as you add a second writer, a slower disk, or an `fsync`-per-write configuration, latencies stretch into the tens of milliseconds — and any other request that landed on the same worker is silently delayed for the same window.

There's also a correctness hazard: tokio's documentation [explicitly warns](https://docs.rs/tokio/latest/tokio/index.html#cpu-bound-tasks-and-blocking-code) that blocking a worker for "longer than 10–100 microseconds" can deadlock the scheduler when combined with other blocking behavior.

## The `spawn_blocking` pattern

The fix is one call. Move the synchronous work onto tokio's dedicated **blocking pool** with [`tokio::task::spawn_blocking`](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html):

```rust
async fn create_note(
    State(state): State<AppState>,
    Json(input): Json<NewNote>,
) -> Result<Json<NoteView>, AppError> {
    let runtime = Arc::clone(&state.runtime);
    let row = tokio::task::spawn_blocking(move || {
        let notes = ModelDelegate::new(&runtime, &cratestack_schema::NOTE_MODEL);
        notes.create(input.into()).run()
    })
    .await??;       // first ? unwraps JoinError, second ? unwraps RusqliteError
    Ok(Json(row.into()))
}
```

The blocking pool is separate from the worker pool, sized for I/O-bound work (default 512 threads), and explicitly designed for code that holds a thread for a long time. The async worker is freed as soon as `spawn_blocking` returns its `JoinHandle` — typically in microseconds.

Three things to notice:

1. **`Arc<RusqliteRuntime>` is the carrier.** `RusqliteRuntime` is not `Clone` by design (the underlying `Mutex<Connection>` shouldn't be silently duplicated). Wrap it in an `Arc` once at startup and clone the `Arc` per call.
2. **Two `?` operators.** `spawn_blocking(...).await` returns `Result<Result<T, RusqliteError>, JoinError>`. The first `?` propagates panics from the blocking task as `JoinError`; the second propagates the underlying `RusqliteError`. You can collapse these with a helper if you'd rather, but the shape is informative.
3. **The closure is `Send + 'static`.** Anything captured by the closure crosses thread boundaries, so request-derived state (`input`, the cloned `Arc`) needs to satisfy `Send`. `RusqliteRuntime` already does — it's `Send + Sync`.

<Info>
Conceptually `spawn_blocking` is "promote synchronous code to async-friendly by paying a thread-pool hop." It's the same pattern you'd use to call a blocking C library from a tokio handler, or to read a stdlib `File` outside `tokio::fs`. There is nothing CrateStack-specific about it — it just happens to be the seam embedded users hit first.
</Info>

## Sharing the runtime

Open the database once at startup, wrap it in `Arc`, and clone the `Arc` everywhere you need it:

```rust
use std::sync::Arc;
use cratestack_rusqlite::RusqliteRuntime;

#[derive(Clone)]
pub struct AppState {
    pub runtime: Arc<RusqliteRuntime>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let runtime = Arc::new(RusqliteRuntime::open("app.db")?);
    bootstrap(&runtime)?;
    let state = AppState { runtime };
    // ...build router with .with_state(state), serve, etc.
    Ok(())
}
```

The `Arc<RusqliteRuntime>` is the **handle** that gets passed around. `Mutex<Connection>` inside the runtime serializes actual SQL access. SQLite in WAL mode allows concurrent readers with at most one writer — but the in-process mutex enforces single-writer at the runtime layer, which is the simplest correct default. If you need a connection pool, open multiple `RusqliteRuntime` instances against the same file (each carries its own connection) and arbitrate access yourself.

<Warning>
Do **not** share a `&RusqliteRuntime` across `spawn_blocking` boundaries via a non-`'static` borrow — the closure has to own the handle. Clone the `Arc` per call. It's a refcount increment, not a connection copy.
</Warning>

## Bridging non-tokio threads

Some libraries (filesystem watchers, OS event hooks, native callback APIs) deliver their events on threads they own — outside tokio's scheduler. The pattern is to push those events into a `tokio::sync::mpsc` channel and process them from a tokio task that owns the database side.

`tokio::sync::mpsc::unbounded_channel` is the typical choice: its `send` is non-async and safe to call from any thread, and `recv` is `async` on the consuming end.

```rust
use tokio::sync::mpsc;

let (tx, mut rx) = mpsc::unbounded_channel::<Event>();

// notify's callback runs on its own thread — push into the channel
let _watcher = notify::recommended_watcher(move |res| {
    if let Ok(event) = res {
        let _ = tx.send(event);
    }
})?;

// Consume from tokio
while let Some(event) = rx.recv().await {
    let runtime = Arc::clone(&state.runtime);
    tokio::task::spawn_blocking(move || persist(&runtime, event)).await??;
}
```

This pattern generalizes — file watchers (`notify`), GUI callbacks, native code calling back into Rust via `extern "C"`, signal handlers — anywhere events arrive on a thread tokio didn't create.

## Graceful shutdown

`axum::serve(...).with_graceful_shutdown(...)` waits for in-flight requests to complete before exiting. Pair it with `tokio::signal::ctrl_c()`:

```rust
let listener = TcpListener::bind(addr).await?;
axum::serve(listener, app)
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("ctrl-c received, shutting down");
    })
    .await?;
```

If you're operating a daemon shape (`tokio::select!` loop) rather than a server, treat shutdown the same way — drain any buffered state, persist via `spawn_blocking`, then return from `main`. Dropping the `Arc<RusqliteRuntime>` triggers SQLite's normal close path; WAL contents are checkpointed into the main database file as part of that. **Do not** abort the process while a blocking task is mid-write — SQLite recovers correctly via WAL on next open, but consistency-critical workloads should let the task drain.

## When *not* to bother

`spawn_blocking` is cheap but it's not free — every call pays a thread-pool dispatch plus the cost of the channel handoff for the result. Two cases where you can skip it:

1. **`#[tokio::main(flavor = "current_thread")]`** — single-threaded runtimes have only one async worker, and blocking it stalls the only thread you have either way. If you're committed to that runtime flavor, holding the connection inline on the same thread is no worse than a `spawn_blocking` hop. (You almost certainly *don't* want this for a server, but it's reasonable for a daemon with one logical task.)
2. **Hot reads that always come from memory.** SQLite's page cache makes repeated reads against the same hot pages effectively in-memory. If profiling shows a read path is sub-microsecond and never touches disk, the `spawn_blocking` overhead can be the dominant cost. Measure before you remove the wrapper.

Defaulting to `spawn_blocking` everywhere is the safe call. Skip it only where you have profiling data to justify the deviation.

## Reference examples

Two examples in the framework repo demonstrate the full pattern end-to-end:

- **[`examples/embedded-daemon`](https://github.com/cratestack/cratestack/tree/main/examples/embedded-daemon)** — `notify` watcher → tokio mpsc → debouncer state machine → `spawn_blocking` flush. The "long-running daemon with local SQLite state" shape. Includes a pure `Debouncer` unit-test boundary (the persistence layer is testable without tokio, the daemon layer requires it).
- **[`examples/embedded-webhook`](https://github.com/cratestack/cratestack/tree/main/examples/embedded-webhook)** — axum + `include_embedded_schema!`, no Postgres. The "small HTTP service with its own SQLite" shape — the inverted twin of the [`server_basic`](https://github.com/cratestack/cratestack/blob/main/crates/cratestack-pg/examples/server_basic.rs) example, which uses `include_server_schema!` + Postgres.

Both have a `lib.rs` / `main.rs` split: `lib.rs` exposes a `build_router` (webhook) or pure `Debouncer` + `persist_event` (daemon) so integration tests can exercise the persistence layer without binding a TCP port or watching a real filesystem. `main.rs` is the thinnest possible wrapper around `tokio::main`.

## Read next

1. [Offline-First with Embedded SQLite](/guides/offline-first-sqlite) — the embedded backend without the async wrapper. Read this first if you haven't.
2. [Telemetry](/guides/telemetry) — wiring `tracing` so the `spawn_blocking` boundary is observable.
3. [Scalars](/reference/scalars) — the canonical TEXT/BLOB encoding that round-trips through SQLite.
