---
title: Idempotency
description: Duplicate-execution protection for mutating routes using the `IdempotencyLayer` and a pluggable reservation store (Postgres or Redis).
---

# Idempotency

Mutating routes are vulnerable to duplicate execution under client retries:
the network drops the response, the client retries, the handler runs twice,
the bank books two transfers. `IdempotencyLayer` solves this by atomically
reserving `(principal, key)` before the handler runs and replaying the
captured response for any subsequent request with the same key.

## Wiring

Pick the backend that fits your deployment. The trait is the same; the
layer doesn't care which store backs it.

### Postgres (`cratestack-sqlx`)

```rust
use cratestack_axum::idempotency::IdempotencyLayer;
use cratestack::SqlxIdempotencyStore;
use std::sync::Arc;
use std::time::Duration;

let store = Arc::new(SqlxIdempotencyStore::new(pool.clone()));
store.ensure_schema().await?;

let router = cratestack_schema::axum::router(db, procedures, JsonCodec, auth)
    .layer(IdempotencyLayer::new(store, Duration::from_secs(24 * 3600)));
```

### Redis (`cratestack-redis`)

```rust
use cratestack_axum::idempotency::IdempotencyLayer;
use cratestack_redis::RedisIdempotencyStore;
use std::sync::Arc;
use std::time::Duration;

let store = Arc::new(RedisIdempotencyStore::open(
    "redis://127.0.0.1/",
    "bank:prod", // key prefix; the store appends `:idem:<sha256(...)>`
)?);

let router = cratestack_schema::axum::router(db, procedures, JsonCodec, auth)
    .layer(IdempotencyLayer::new(store, Duration::from_secs(24 * 3600)));
```

Redis is the right choice when:

1. you already operate a Redis cluster for sessions / caching and don't
   want a second durable store
2. you want eviction handled by the data store — Redis drops keys on TTL,
   no `garbage_collect()` sweep needed
3. your idempotency window is short (minutes to hours) so durability vs
   Postgres matters less than the operational simplicity

Postgres remains the right choice when:

1. you already run Postgres for the application data and want one
   transactional system of record
2. you need the idempotency rows for forensic reconstruction beyond their
   TTL, or want them to participate in logical replication
3. you care about transactional consistency between the idempotency row
   and other writes the handler does

The TTL is a hard upper bound on how long an in-flight reservation pins a
key. Banks running long-tail async workflows pick 24 h; consumer-facing
POST flows pick 5–60 minutes.

## Request shape

Clients opt in by sending `Idempotency-Key`:

```http
POST /transfers HTTP/1.1
Content-Type: application/json
Idempotency-Key: 7a3f-0b21-c9d4-8e15

{"from":1,"to":2,"amount":"100.00"}
```

The key must be ASCII, non-empty, and at most 255 characters. Missing keys
bypass the layer entirely — the layer is opt-in per request.

## State machine

For each request the store atomically returns one of:

1. **Reserved** — fresh claim. The handler runs and the response is persisted on completion.
2. **Replay** — a prior execution under the same key + request hash has completed. The cached response is returned with `Idempotency-Replayed: true`.
3. **InFlight** — another caller still holds the reservation. The layer returns `409 Conflict` with `Retry-After: 1`.
4. **Conflict** — the same key arrived with a different request body. The layer returns `422` with `idempotency_key_conflict`, per the IETF draft.

The request hash is SHA-256 over method, full path **including query
string**, content-type, and body. `POST /transfer?dry_run=true` and `POST
/transfer?dry_run=false` therefore hash differently — replays don't cross
query-string-encoded operation modes.

## Error bodies are typed

Every response this layer emits itself carries the framework's own
codec-negotiated error envelope, encoded through the same `Accept`
negotiation the generated handlers use — the REST `CratestackErrorResponse`
`{code, message, details}` on ordinary paths, `RpcErrorBody` on `/rpc/*`
ones. That covers the in-flight `409`, the `422` key conflict, the
principal-fingerprint refusal (`412`), and the buffer-limit errors. Before
0.11.0 these were bare `text/plain` strings that a generated client could
not branch on ([#846](https://github.com/cratestack/cratestack/issues/846));
consumers asserting on them as text will see the change.

An unsatisfiable or malformed `Accept` falls back to the default codec and
**keeps the original status** rather than becoming a 406 or 400 — `Accept`
is caller-controlled, and a caller must not be able to rewrite the status of
a refusal aimed at it.

<Note>
  **This layer gets no fail-open policy.** Unlike
  [rate limiting](./rate-limiting#when-the-store-fails), a failed idempotency
  store must keep failing the request — that is the entire point of having
  one. What did change is promptness: `RedisIdempotencyStore` now configures
  explicit 2-second connection and response timeouts on its
  `ConnectionManager`, so it fails fast instead of awaiting an unbounded
  reconnect. It also gets no retry-once, because a double-apply is exactly
  what it exists to prevent.
</Note>

## Replay fidelity

Replays reproduce the original response's:

1. status code
2. body bytes
3. every end-to-end response header the handler set (`Location`, `ETag`, `Cache-Control`, `Set-Cookie`, `Content-Type`, …)

Hop-by-hop headers (`Connection`, `Transfer-Encoding`) and framework-computed
headers (`Content-Length`, `Date`) are filtered at capture time and not
restored. A replay carries an additional `Idempotency-Replayed: true`
header so downstream observers can distinguish it from a live execution.

## Reservation tokens

Every reservation carries a UUID `reservation_id`. `complete` and `release`
require a matching token, so a handler that runs past the TTL and has its
row reclaimed by a retry cannot poison the newer reservation. The classical
TTL-overrun scenario degrades to a silent no-op rather than a wrong-response
write. This guarantee holds in both the Postgres and Redis stores.

The Redis store additionally guards `release` on `status == 'in_flight'`
(matching the Postgres store's `AND response_body IS NULL` clause), so a
spurious `release` arriving after `complete` is also a no-op rather than
wiping the captured response.

## Principal scoping

The layer derives a principal fingerprint from the request. Two callers
sharing a key under different principals do **not** collide. The default
fingerprint is a SHA-256 of the `Authorization` header; services running
mTLS or session cookies override it:

```rust
IdempotencyLayer::new(store, ttl)
    .with_principal_fingerprint(|req| {
        req.extensions().get::<TenantId>().map(|t| t.to_string()).unwrap_or_else(|| "anonymous".to_owned())
    })
```

## Persistence

### Postgres layout

`SqlxIdempotencyStore` ships an `ensure_schema()` helper that idempotently
creates the table and index. The DDL is:

```sql
CREATE TABLE cratestack_idempotency (
    principal_fingerprint TEXT NOT NULL,
    key TEXT NOT NULL,
    request_hash BYTEA NOT NULL,
    reservation_id UUID NOT NULL,
    response_status INT,
    response_headers BYTEA,
    response_body BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (principal_fingerprint, key)
);

CREATE INDEX IF NOT EXISTS cratestack_idempotency_expires_idx
    ON cratestack_idempotency (expires_at);
```

`SqlxIdempotencyStore::garbage_collect()` deletes rows whose `expires_at`
has passed. Banks call it from a scheduled task; the request path takes
over a single expired row on demand but doesn't sweep.

### Redis layout

`RedisIdempotencyStore` writes one Redis hash per `(principal, key)` at:

```text
<prefix>:idem:<sha256(principal || 0x00 || key)>
```

Hashing both sides keeps the Redis key bounded regardless of how long the
principal fingerprint or idempotency key grows, and avoids any escaping
concerns around `:` in user-supplied values. Hash fields hold the
request hash, status, reservation token, captured response bytes, and
timestamps — all as raw bytes (Redis hash values are binary-safe; no
base64 wrapping is needed).

Atomicity comes from three small Lua scripts: `reserve_or_fetch`,
`complete`, and `release`. They run via `EVALSHA` with a `NOSCRIPT`
fallback, so the script body is loaded into the Redis server once per
instance and reused across requests.

Eviction is driven by `PEXPIREAT` — there is no separate GC. When the
TTL passes, Redis drops the hash; the next reservation observes a
missing key and claims a fresh slot. A late `complete` or `release`
from the previous reservation finds a rotated token and becomes a
silent no-op.

## Custom stores

The `IdempotencyStore` trait is async + dyn-compatible. Banks running
multi-region deployments can plug in their own backing store — typically
a Postgres replica with logical replication, a globally-consistent
key-value store, or a Redis Enterprise CRDT cluster — so the reservation
guarantee holds across regions.

## Caveats

The shipped Postgres and Redis stores enforce the reservation guarantee
within one database instance (or Redis primary). Banks running
active-active multi-region clusters must either:

1. accept that retries hitting a different region within the TTL race the
   reservation, or
2. plug a globally-coordinated store into `IdempotencyStore` and bring
   that consensus layer's latency budget into the request path.

Both shipped stores assume a single logical service per
`principal_fingerprint`. Services that share a backing store between
unrelated applications should namespace the key in the fingerprint
function — and, for Redis, choose a per-application `key_prefix` so
deployments can't trample each other's keys.
