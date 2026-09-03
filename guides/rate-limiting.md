---
title: Rate Limiting
description: Per-principal token-bucket rate limiting via `RateLimitLayer` and the pluggable `RateLimitStore` trait.
---

# Rate Limiting

`RateLimitLayer` caps how often a single principal can hit the router. The
shipped algorithm is a per-key token bucket with configurable burst size
and refill rate. Banks use it to dampen abuse on customer-facing channels
without writing per-route guards.

## Wiring

```rust
use cratestack_axum::ratelimit::{
    InMemoryRateLimitStore, RateLimitConfig, RateLimitLayer,
};
use std::sync::Arc;

let store = Arc::new(InMemoryRateLimitStore::new());
let config = RateLimitConfig::new(/* burst */ 60, /* refill */ 1.0);

let router = cratestack_schema::axum::router(db, procedures, JsonCodec, auth)
    .layer(RateLimitLayer::new(store, config));
```

`RateLimitConfig` carries:

1. `burst` — maximum tokens in the bucket (the largest peak the layer accepts)
2. `refill_per_second` — tokens added back per wall-clock second

A bucket configured `(60, 1.0)` lets a caller burst 60 requests, then
steady-state 1 request per second.

## Request flow

For every request the layer:

1. derives a key from the request (default: `Authorization` header SHA-256 fingerprint)
2. asks the store to consume one token
3. either forwards the request and adds `X-RateLimit-Limit` + `X-RateLimit-Remaining` headers to the response
4. or returns `429 Too Many Requests` with `Retry-After: <seconds>` and a typed error body

The two `X-RateLimit-*` headers ride on **allowed** responses only — a 429
carries `Retry-After` and no budget headers. There is no
`X-RateLimit-Reset`.

<Warning>
  **The 429 body is a typed error envelope, not a string.** Every response
  this layer emits itself now carries the framework's own codec-negotiated
  error envelope — the REST `CratestackErrorResponse` `{code, message, details}`
  on ordinary paths, `RpcErrorBody` on `/rpc/*` ones — encoded through the
  same `Accept` negotiation the generated handlers use. It used to be a bare
  `text/plain` body reading `rate limit exceeded`, which generated clients
  reported as an unrecognized error body rather than a code they could branch
  on. Consumers asserting on that string need updating;
  [#846](https://github.com/cratestack/cratestack/issues/846). `Retry-After`
  and the `X-RateLimit-*` headers are unchanged.

  The code is `TOO_MANY_REQUESTS` over REST and `resource_exhausted` over
  RPC, backed by the `CratestackError::TooManyRequests` variant.
</Warning>

Content negotiation never rewrites the status of these responses. `Accept`
is caller-controlled, so passing a negotiation failure through would let any
caller downgrade its own throttle — `Accept: text/html` turning a 429 into a
406, a malformed `Accept` into a 400. An unsatisfiable or malformed `Accept`
instead falls back to the default codec (`application/cbor`) and keeps the
original status, which RFC 9110 §12.5.1 explicitly permits for a
server-originated response.

The same treatment covers the [idempotency layer](./idempotency)'s own
emitted errors — key conflict, in-flight `409`, fingerprint refusal, and the
buffer-limit errors.

## Key function

The default fingerprint matches the idempotency layer's. Banks running
tenant-scoped budgeting override it:

```rust
RateLimitLayer::new(store, config).with_key_fn(|req| {
    req.headers()
        .get("x-tenant-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("anonymous")
        .to_owned()
})
```

Two callers sharing a tenant share a bucket. Two callers from different
tenants get independent buckets.

## Stores

The shipped implementation is `InMemoryRateLimitStore` — a `HashMap` of
buckets behind a `Mutex`. It is appropriate for:

1. single-replica deployments
2. development and testing
3. per-pod fairness in deployments where the upstream load balancer already shards by principal

Multi-replica deployments need a shared store.

### Redis (`cratestack-redis`)

`RedisRateLimitStore` backs the same trait with a Redis hash per bucket key
and a Lua script that does the read-refill-decrement-write cycle in one
round-trip, so concurrent replicas can't race the same bucket:

```rust
use cratestack_axum::ratelimit::{RateLimitConfig, RateLimitLayer};
use cratestack_redis::RedisRateLimitStore;
use std::sync::Arc;

let store = Arc::new(RedisRateLimitStore::open(
    "redis://127.0.0.1/",
    "bank:prod", // key prefix; the store appends `:rl:<sha256(key)>`
)?);
let config = RateLimitConfig::new(/* burst */ 60, /* refill */ 1.0);

let router = cratestack_schema::axum::router(db, procedures, JsonCodec, auth)
    .layer(RateLimitLayer::new(store, config));
```

Each `consume` refreshes the bucket's `EXPIRE` to the time it would take to
refill from empty (clamped to 24h), so idle buckets evict themselves —
no separate reaper needed even under a high-cardinality, tenant-scoped key
space.

#### Retry-once on a dropped connection

`RedisRateLimitStore::consume` re-issues its script exactly once when the
first attempt fails with a transport-class error, keyed on
`RedisError::is_unrecoverable_error` — precisely the set `ConnectionManager`
itself reconnects on, so "the driver considers this connection finished" and
"we treat it as transport-class" cannot drift apart. That set also covers a
half-read reply from a dying socket, which a narrower connection-dropped
check misses.

`ConnectionManager`'s contract is that the command which *observes* a dropped
connection still fails while the manager reconnects in the background, so a
Redis idle-timeout used to cost exactly one user-visible request. The retry
awaits the replacement connection instead.

Deliberately bounded: exactly one retry, never a loop, and never for a
deterministic refusal such as `OOM` or `NOSCRIPT`. `consume` is not
idempotent, so a retry after a mid-flight drop can spend a second token —
one token out of a bucket that exists for approximate capacity protection,
weighed against a failed user request. The idempotency store gets no such
retry, for the opposite reason: there, a double-apply is the exact thing it
exists to prevent.

#### Connection timeouts

Both Redis stores configure explicit connection and response timeouts on the
`ConnectionManager` (**2 s each**), so a store used outside this layer is
bounded too — including `RedisIdempotencyStore`, which stays fail-closed but
now fails promptly instead of awaiting an unbounded reconnect.

### Writing a custom store

The `RateLimitStore` trait is async and dyn-compatible, so a store other
than the two shipped above is a small surface to implement:

```rust
#[async_trait::async_trait]
pub trait RateLimitStore: Send + Sync + 'static {
    async fn consume(
        &self,
        key: &str,
        config: RateLimitConfig,
    ) -> Result<RateLimitDecision, CratestackError>;
}
```

`RateLimitDecision` is either `Allowed { remaining }` or
`Throttled { retry_after_secs }`.

## When the store fails

A store can fail: the socket breaks, Redis is unreachable, the server
refuses a write. What the layer does then is configurable, and the default
changed in 0.11.0 ([#846](https://github.com/cratestack/cratestack/issues/846)).

```rust
use cratestack_axum::ratelimit::{RateLimitLayer, StoreErrorPolicy};
use std::time::Duration;

let layer = RateLimitLayer::new(store, config)
    .with_store_error_policy(StoreErrorPolicy::Deny)
    .with_store_timeout(Duration::from_millis(1_500));
```

### `StoreErrorPolicy` is class-conditional, not a blanket fail-open

`StoreErrorPolicy::Allow` is the default. It is **not** "serve every request
when the store misbehaves". It serves a request unthrottled only when the
store failure is *transport-class* — the socket broke, the server is
unreachable, the lookup exceeded its budget. Backends signal that class with
`CratestackError::Unavailable`; every other store failure refuses the request
exactly as `StoreErrorPolicy::Deny` would.

That distinction is the whole design. A blanket fail-open rests on the
premise that a store failure is never caller-controlled, and that premise is
false: the default key function hashes an **unvalidated** `Authorization`
header, so an unauthenticated caller mints one Redis key per request just by
rotating it. Driven to `maxmemory`, every write then fails with `OOM` — and a
blanket fail-open would serve *every* request through, including from buckets
already exhausted. That is a global limiter bypass reachable by anyone.

So an `OOM`, a `NOPERM`, a poisoned mutex or a malformed reply — all
reachable-and-refusing, none self-healing — stay closed. A broken pipe is
caused by nobody, fixable by nobody in the request path, and self-heals;
refusing there would turn a limiter hiccup into a simultaneous outage of
every rate-limited route, which is why it is the one class that degrades to
unlimited.

<Warning>
  **`StoreErrorPolicy::Deny` restores the pre-0.11.0 behaviour** — every
  store failure, transport included, refuses the request. That is what
  deployments using the limiter as a *security* control (a paywall, a
  brute-force guard) rather than a *capacity* control want. `RateLimitConfig`
  has no env-driven surface, so this is a builder-only knob; there is no
  environment variable to set.
</Warning>

Key derivation itself stays fail-closed under **both** policies: a request
the layer cannot identify is refused with `412 Precondition Failed` before
the store is consulted at all. The policy is never reached on that path.

### `with_store_timeout` bounds the lookup

`with_store_timeout(Duration)` — default **500 ms** — caps one `consume`,
first attempt *and* any backend-internal retry, as a single budget. An
elapse is reported as a transport-class failure.

Without it, "degrade to unlimited" silently meant "hang, then allow":
`redis`'s `ConnectionManager` defaults both its connection and response
timeouts to `None`, so each attempt awaited an unbounded reconnect cycle —
measured at 9.46 s, doubled to 18.92 s by the retry. Nineteen seconds of
blocking is worse for the caller than the refusal it replaced, and is itself
a denial-of-service lever.

<Warning>
  **Check the 500 ms default against your Redis latency.** A store whose p99
  `consume` exceeds the budget is classified transport-unavailable and, under
  the default `Allow`, served **unthrottled** — so an under-provisioned or
  cross-region Redis becomes a silent partial limiter bypass rather than a
  slow one. Raise the budget with `with_store_timeout`, or set `Deny`, rather
  than taking the default on faith. The condition is visible in the logs
  below, but only if someone is reading them.
</Warning>

### What gets logged

Both store-error paths emit a throttled `WARN`, so an attacker-induced outage
cannot double as a log-volume amplifier. Each carries the count it suppressed:

1. `"rate limit store error"` — one 10-second budget, naming the error, the
   policy in force, and whether the request was served unthrottled
2. the fail-open notice — one 60-second budget, emitted only when a request
   actually goes through without a limit applied

The mechanism is `cratestack_core::log_throttle` (`LogThrottle` /
`ThrottleDecision`), a public module usable by any crate with the same
problem. It is deliberately not a general-purpose rate limiter: no token
bucket, no configuration, no allocation. The throttles are per-layer
instances rather than process-wide statics, so one router's outage cannot
silence another's.

## Choosing parameters

Practical starting points:

1. customer-facing read endpoints: burst 30, refill 2.0 — accommodates page-load bursts
2. mutating endpoints: burst 10, refill 0.5 — same caller can do meaningful work but not script floods
3. operator/back-office endpoints: burst 600, refill 10.0 — humans behind a workstation, not bots

Banks layer the rate limit with [idempotency](./idempotency) — the rate
limit caps the rate at which retries hit the layer; the idempotency layer
caps how many of those retries actually run the handler.

## Caveats

1. `InMemoryRateLimitStore` does not bound the key map. Long-running
   processes facing a high-cardinality key space (per-IP, per-session)
   should swap to a TTL-aware store.
2. The token bucket is wall-clock-driven; a process pause longer than one
   bucket-fill window grants a fresh burst on resume.
3. `InMemoryRateLimitStore` does not persist across restarts. That is the
   right choice for per-pod fairness and the wrong choice for global
   enforcement — reach for `RedisRateLimitStore` when buckets need to
   survive a restart or be shared across replicas.

## Read Next

1. [Idempotency](./idempotency) for the duplicate-execution protection that pairs naturally with rate limiting
2. [Auth provider](./auth-provider) for the principal model the key function reads from
