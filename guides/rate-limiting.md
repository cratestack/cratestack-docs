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
4. or returns `429 Too Many Requests` with `Retry-After: <seconds>` and an explanation body

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
    ) -> Result<RateLimitDecision, CoolError>;
}
```

`RateLimitDecision` is either `Allowed { remaining }` or
`Throttled { retry_after_secs }`.

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
