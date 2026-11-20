---
title: Subscriptions
description: Live data from a CrateStack server — model feeds (`@@subscribe`), subscription procedures and topics — over SSE, WebSocket or WebTransport, with the read policy applied to every event, streams ended when a principal is revoked, and typed Rust, TypeScript and Dart clients.
---

# Subscriptions

> **Since 0.18.0.** Everything on this page shipped in 0.18.0: the backplane (cratestack#1266),
> refusal, filters and REST (cratestack#1267), subscription procedures, topics, the WebSocket
> binding and the Rust client (cratestack#1268), and the TypeScript and Dart clients. The design
> is `docs/design/subscriptions-websocket.md` in the framework repository.

A subscription is an op like any other. It has an op id, a policy, and an input. What it
returns is a stream: once the server says **Ready**, nothing committed after that point is
missed. The other outcome is that the stream ends with `unavailable`, and the client
resubscribes and refetches. That single contract holds on every binding.

## What you can subscribe to

### Model feeds

```text
model Note {
  id Int @id
  ownerId Int
  body String
  archived Boolean

  @@allow("read", ownerId == auth().id)
  @@deny("read", archived)
  @@emit(created, updated, deleted)
  @@subscribe
}
```

`@@subscribe` requires `@@emit(...)`. It works under `transport rpc`, where the op id is
`model.Note.subscribe`, and under REST, where the feed is `GET /notes/$subscribe`.

Every event passes the subscriber's **read policy**: the same `@@allow`/`@@deny` rules `get`
applies, decided against the event's record. Two cases are refused at open:

- **A caller no row could pass.** An anonymous caller on `ownerId == auth().id` is refused with
  `unauthenticated` (401); an authenticated one with `permission_denied` (403).
- **A policy that reads a `@server_only` column.** The event does not carry that column, so the
  policy cannot be decided.

A feed takes `list`'s own filter syntax, plus `operations` and `fields`:

```text
GET /rpc/subscribe/model.Note.subscribe?body__contains=keep&operations=created&fields=id,body
```

The filter is evaluated in memory against the event's row, and it only narrows what the policy
already allows. Some inputs are refused with `invalid_argument`:

- paging and shaping keys (`limit`, `sort`, `include`, …);
- relation and full-text filters;
- a filter over a `@server_only` column.

**Rows that leave your feed.** When an update moves a row *out of* your filter, or out of what
your read policy lets you see, you receive an `Updated` event with `matches: false`. Its `data` is
the row as you last saw it, not the new values, so remove that row (by its key) from your local
copy. Ordinary events leave `matches` out, which means `true`. You are not told why the row left,
and nothing is sent about rows you never matched. There is no exit event for `update_many` or for
a feed whose `operations` exclude `updated`, so still refetch after a bulk update and when you
reconnect. In the clients: `ModelEvent.matches` (Rust), `matches?: boolean` (TypeScript; test
`=== false`), `CratestackModelEvent.matches` (Dart).

### Subscription procedures and topics

Live data that is not a row change has its own construct. A topic carries typed messages under
a key, to every replica. A subscription procedure is the policy boundary that exposes one:

```text
type RoomArgs {
  roomId String
}

type ChatMessage {
  roomId String
  body String
}

topic RoomMessage(roomId: String): ChatMessage

subscription procedure roomMessages(args: RoomArgs): ChatMessage
  @allow(auth() != null)
```

The handler runs once, at open. Its `Err` refuses the subscription before Ready. The stream it
returns *is* the subscription:

```rust
impl cratestack_schema::procedures::ProcedureRegistry for Rooms {
    async fn room_messages(
        &self,
        db: &cratestack_schema::Cratestack,
        _ctx: &CratestackContext,
        args: room_messages::Args,
        _authorized: room_messages::Authorized,
    ) -> Result<SubscriptionStream<room_messages::Output>, CratestackError> {
        if args.args.roomId == "secret" {
            return Err(CratestackError::Forbidden("not a member of this room".to_owned()));
        }
        db.topics().room_message(&args.args.roomId).subscribe().await
    }
}
```

`db.topics().room_message(&id)` has three methods:

- **`publish(&msg)`** delivers to every current subscriber, on every replica.
- **`publish_in_tx(tx, &msg)`** sends the notification from inside your transaction, so the
  message is delivered only if the transaction commits:

  ```rust
  db.transaction(async |tx| topics.room_message("r1").publish_in_tx(tx, &msg).await).await?;
  ```

- **`subscribe()`** is what a handler usually returns.

Inside an `@isolation` procedure, take topics from the handle you are given: `tx_db.topics()`.
Their `publish` rides the procedure's transaction. The message is delivered when the attempt
commits, and never for an attempt that errors or is retried after a serialization failure, so
there is no need to publish "after the commit" yourself. With the default `PgNotifyBackplane` it
notifies inside the transaction; with `InProcessBackplane` it is queued and sent once the attempt
commits. Inside `tx_db.transaction(async |tx| ..)`, call `publish_in_tx(tx, &msg)`. If that
`transaction(..)` rolls back, its messages are dropped even though the attempt around it commits.

A subscription procedure returns one item type (not `T[]`). It cannot declare `@stream`,
`@isolation`, `@no_idempotency`, `@status`, `@no_rate_limit` or `@mcp`. It may declare `@frames(unsigned)` (below). It works under
`db = None` too, with your own stream as the source.

Topics work under `db = None` as well, on `cratestack-api`: the same `db.topics().room_tick(&id)`
with `publish` and `subscribe`, but no `publish_in_tx`, since there is no transaction; publish once
the work is done. The default backplane is an `InProcessBackplane` shared by every
`Cratestack::builder().build()` of the schema in the process, so it reaches one replica only. To reach
others, pass your own `SubscriptionBackplane` with `Cratestack::builder().with_backplane(Arc::new(..))`.
A `db = None` schema that declares a topic has a `Cratestack` that is `Clone` but not `Copy`.

### Signed services: `@frames(unsigned)`

*Since 0.20.4, [cratestack#1378](https://github.com/cratestack/cratestack/issues/1378): the server and the generated Rust, TypeScript and Dart clients.*

A service that requires [signed requests](./signed-transport) cannot stream to a signed client, because a stream cannot be sealed. Mark a subscription procedure `@frames(unsigned)` to let it open signed:

```text
subscription procedure roomMessages(args: RoomArgs): RoomEvent
  @frames(unsigned)
```

The open is verified like a unary call and `@allow` sees the principal its signature names, but **the frames that follow are not signed**. Treat each as a hint (an id) and re-read through a sealed call. The stream ends after `max_signed_stream_life` (default one hour) with `unavailable` / `stream lifetime`, and the client resubscribes. The only argument is `unsigned`; `sealed` and `chain` are reserved and refused, and `@frames` is refused on unary and `@stream` procedures and when repeated. It is part of the op contract, so adding or removing it is wire-incompatible, and it does not apply to `@@subscribe` model feeds. Details, the wire and the limits: [Signed subscriptions](./signed-transport#signed-subscriptions-frames-unsigned).

The generated clients open it signed; a client that holds an envelope never opens a subscription in plain:

- **Rust.** `subscribe()` seals the open (a `POST` of the input's CBOR on RPC, a `GET` with a body on REST) and reads the plain stream, over cbor-seq (`Auto` picks it) or SSE. An unmarked subscription, a WebSocket or WebTransport pin, and REST on `wasm32` are `EnvelopeError::StreamsUnsupported`, with nothing sent. A stream that lost `Cratestack-Frames: unsigned`, a forged plain `200` or the wrong `Content-Type` is `EnvelopeError::UnsignedFramesRefused`.
- **TypeScript.** Give the runtime `subscriptions: { seal: createSealedSubscriptions({ cose, contracts }) }`. RPC only: a REST route is a `CoseFailure` `misuse`. An unmarked subscription or a socket pin is a `CratestackSubscriptionError` with code `streams_unsupported`. The sealed `fetch` never follows a redirect, and an unsigned refusal is `unsigned_refusal`, never a server code. A cross-origin browser page needs the server to send `Access-Control-Expose-Headers: Cratestack-Frames`.
- **Dart.** Opt in with `CratestackSubscriptionOptions(sealsSubscriptions: true)`. The generated client then hands your signing `CratestackHttpTransport` the route and contract in `request.extra` and refuses an answer without the marker (`unsigned_frames_refused`); an unmarked subscription and a socket pin are `streams_unsupported`, and an unsigned refusal is `unsigned_refusal`. Without the opt-in a subscription opens as it always did. It never seals itself.

Each reconnect is a new signed open. A relay can forge the terminal `unavailable` frame, so resubscribe with a jittered backoff. See [Signed subscriptions](./signed-transport#from-the-generated-clients).

## Every replica sees every event

Events reach subscribers through the **subscription backplane**. The default,
`PgNotifyBackplane`, uses Postgres `LISTEN`/`NOTIFY`, and the writing transaction itself
notifies. A subscriber on replica B therefore sees a write committed on replica A, in commit
order, and only if it committed.

When the listener reconnects, events may have been lost, so every subscription on that replica
ends with `unavailable` / `"subscription interrupted"`. Behind PgBouncer in transaction mode,
`LISTEN` does not work. In that case, run a single replica with
`Cratestack::builder(pool).with_backplane(Arc::new(cratestack::InProcessBackplane::new()))`.

### Byte payloads on the backplane

*(since 0.20.6, [cratestack#1419](https://github.com/cratestack/cratestack/pull/1419))*

The backplane carries more than the framework's own events: your app can publish to a channel too. Until 0.20.6 a payload was text. Now `SubscriptionBackplane::publish_bytes(channel, &[u8])` sends a byte payload (a CBOR-encoded row, say), and a subscriber receives it as `BackplaneMessage::Bytes(Arc<[u8]>)`, exactly as published. Text (`BackplaneMessage::Payload`) and bytes can be mixed on one channel and arrive in the order they were published. `InProcessBackplane` and `PgNotifyBackplane` implement it.

```rust
use cratestack::{BackplaneMessage, CratestackCodec, CborCodec};
use futures_util::StreamExt;

// Encode with CrateStack's own CBOR, not hand-rolled base64.
let bytes = CborCodec.encode(&row)?;
backplane.publish_bytes("rows.invoice", &bytes).await?;

let mut rx = backplane.subscribe("rows.invoice").await?;
while let Some(message) = rx.next().await {
    match message {
        BackplaneMessage::Bytes(bytes) => { /* decode with the same codec */ }
        BackplaneMessage::Payload(text) => { /* text published on this channel */ }
        // Required: the enum is #[non_exhaustive] (see below).
        _ => {}
    }
}
```

`Resync` and `Lagged` fall under the wildcard in this sketch; a real consumer ends the stream on either, as the framework's own do. Encoding is the publisher's job: the backplane moves bytes and never looks inside them.

A hand-written `SubscriptionBackplane` still compiles, because `publish_bytes` has a default. The default returns an `Internal` error, "this backplane does not carry byte payloads", so override it if your backplane should carry bytes.

The framework's own text channels (the model feed, topics and revocations) never publish bytes. Should a stray `Bytes` message reach one, that consumer logs a `warn!`, skips the message and keeps running. It does not end the stream or panic.

#### The `NOTIFY` envelope is CBOR

*(since 0.20.6, [cratestack#1419](https://github.com/cratestack/cratestack/pull/1419))*

`PgNotifyBackplane` now writes each notification on the `cratestack_events` Postgres channel as the text `cbor:` followed by the standard, padded base64 of a CBOR map:

| key | content |
|---|---|
| `v` | the version marker, `1`. Any other version is refused |
| `c` | the backplane channel |
| `t`, `b` or `r` | exactly one of: the text payload, the byte payload, or the 16-byte outbox event id |
| `n` | a nonce, so Postgres does not fold two identical notifications of one transaction into one. Readers ignore it |

The `cbor:` prefix cannot be confused with the legacy JSON envelope, which starts with `{`. Unknown keys are skipped.

- **The limit is on the final text.** Postgres refuses a notification of 8000 bytes or more. The backplane applies **7,900 bytes** to the finished `cbor:` text, not to the payload, and base64 grows 3 bytes into 4. The largest byte payload that fits is therefore about **5.8 KB**, depending on the channel name.
- **A text payload now fits in less.** Under CBOR a plain-text `publish` or topic message must fit in about **5,900 bytes** with a one-character channel, less the channel's length (5,866 for a 35-character topic channel). Under JSON it is about 7,870 (7,840). A text payload between those sizes used to be sent and now errors with `BadRequest`, unless `PgNotifyBackplane::use_json_envelope()` is on, which keeps the JSON figure.
- **An oversized byte payload is an error.** `publish_bytes` returns `BadRequest` that names the payload size, the encoded size and the limit. It never truncates, and there is no outbox fallback, because no row holds the payload. Split it, or keep the bytes elsewhere and publish a reference.
- **A text model event still falls back.** One over the limit goes as a reference to its outbox row, as before. If even the reference does not fit, the write fails with `CratestackError::Internal` (the model name is the schema's, not the caller's input) instead of committing an event no subscriber is told of. Under CBOR that starts at a model name of about 5,880 characters (JSON: about 7,860); in 0.20.5 it needed about 7,900 and failed the statement with a database error.
- **The reader reads both envelopes.** A 0.20.6 replica understands the CBOR envelope and the legacy JSON one (`{"c","p","r","n"}`, plus `b` for bytes), so it hears a 0.20.5 replica. Whitespace before the JSON `{` is accepted, as 0.20.5 accepted it. The nonce `n` is ignored.
- **The readers are strict.** A notification is refused, logged with `warn!` and skipped when it is bad base64 or bad CBOR, has an unknown version, carries no payload, or is ambiguous: under CBOR a duplicate key, a second payload key (`t`/`b`/`r`) or bytes after the map; under JSON more than one of `p`/`r`/`b`. The listener keeps running.

#### Rolling deploy from 0.20.5

A 0.20.5 replica cannot read the CBOR envelope: its JSON parse fails and it skips the notification. During a mixed rollout, model events and topic messages written by a 0.20.6 replica would not reach it. In two steps:

1. **Deploy 0.20.6 with `PgNotifyBackplane::use_json_envelope()` called at startup on every replica.** They write the legacy JSON envelope that old replicas read, and read both.
2. **Once no 0.20.5 replica is left,** remove the call and redeploy. They write CBOR from then on.

```rust
// Once, at startup, before the first write.
PgNotifyBackplane::use_json_envelope();

let backplane = Arc::new(PgNotifyBackplane::new(pool.clone()));
let db = Cratestack::builder(pool).with_backplane(backplane.clone()).build();
```

`use_json_envelope()` is a **process-wide switch**, not a setting of one backplane. It covers every `PgNotifyBackplane` in the process, built before or after the call, and the writers that hold no backplane (a model event's outbox write, a topic's `publish_in_tx`). Writes made before the call went out as CBOR, and the switch cannot be undone in-process: to go back, redeploy without it. `with_json_envelope()` is a thin builder wrapper around it (`PgNotifyBackplane::new(pool).with_json_envelope()`); it is just as process-wide. In JSON mode a byte payload goes as base64 in a new field, `b`, which 0.20.5 readers ignore: bytes reach 0.20.6 replicas only. The 7,900-byte limit then applies to the base64 text. Skipping step 1 costs a 0.20.5 replica the notifications it cannot read, until it is upgraded.

#### Source-breaking edges

*(since 0.20.6, [cratestack#1419](https://github.com/cratestack/cratestack/pull/1419))*

- `BackplaneMessage` gains the variant `Bytes` and becomes `#[non_exhaustive]`. A `match` on it outside `cratestack-core` needs a wildcard arm, now and for every later variant.
- `SubscriptionBackplane` gains `publish_bytes`. It is defaulted, so a hand-written backplane compiles but refuses bytes until it overrides it.
- `LocalHub::deliver` (`#[doc(hidden)]`) now takes a `BackplaneMessage`, not an `Arc<str>`.

## The bindings

| Binding | Where | Frames | When |
|---|---|---|---|
| SSE | `/rpc/subscribe/<op>` (`GET` with the input as the query, or `POST` with a JSON body); REST `GET /<plural>/$subscribe`, `GET /$procs/<name>` | `event: ready`, `event: message`, one `event: error`; `: keepalive` every 15 s; JSON | everywhere |
| `application/cbor-seq` *(since 0.20.3, [cratestack#1001](https://github.com/cratestack/cratestack/issues/1001))* | the same SSE routes with `Accept: application/cbor-seq`: RPC `GET` and `POST /rpc/subscribe/<op>`, REST `GET /<plural>/$subscribe`, `GET /$procs/<name>` | one CBOR `ServerFrame` per item of a CBOR sequence; a CBOR `null` every 15 s; a `Uuid` is a byte string | a CBOR-only client, or a proxy that mangles `text/event-stream`; plain HTTP |
| WebSocket | `GET /rpc/ws` (`/$ws` on REST), with `extension websocket { }` + the `websocket` feature | `Init`, multiplexed `Request`s, `Ready` / `next` / `end` / `err`, `cancel`; CBOR (binary) or JSON (text) | one connection for many subscriptions; where UDP is blocked |
| WebTransport | `CONNECT /rpc/wt` on a separate UDP listener, with `extension webtransport { }` + the `webtransport` feature | the same frames, one QUIC stream per subscription | no head-of-line blocking; survives a network change |

*(Since 0.19.6, [cratestack#1360](https://github.com/cratestack/cratestack/issues/1360).)*
On the CBOR WebSocket and WebTransport bindings, an item is encoded the way a unary CBOR response is: a
`Uuid` (every model event's `eventId` too) is a 16-byte string, and `Bytes` inside a `Json` field is a
byte string. JSON frames (text messages, NDJSON) and SSE are byte-for-byte what they were: a `Uuid` is
text and bytes are an integer array (base64 inside a `Json` field). A schema `Bytes` field is an integer
array on every wire. A request's `input` may carry byte strings on CBOR too, though a `Uuid` subscription
*argument* must still be text, because the input becomes a query string. Before this, the CBOR bindings
sent `Uuid`s as text and bytes inside a `Json` field as base64, and a request `input` holding a byte
string closed the socket with 4400.

Serving the session bindings:

```rust
// WebSocket: a router to merge into yours.
let app = cratestack_schema::axum::rpc_router(db.clone(), registry.clone(), (), CborCodec, auth.clone(), limit)
    .merge(db.subscriptions(registry.clone()).websocket(
        // `.rate_limit(..)` is optional (since 0.19.3); without it, opens are unlimited.
        WebSocketConfig::new().rate_limit(rate_limit_layer.for_subscriptions()),
        auth.clone(),
    ));

// WebTransport: a second listener, on UDP.
let server = db.subscriptions(registry).webtransport(config, auth)?;
tokio::spawn(server.serve());
```

Without a subscription procedure, `db.subscriptions()` takes no registry.

Both session bindings authenticate with the router's `AuthProvider`. A native client sends its
credentials on the handshake; a browser, which cannot set headers there, sends them in the
`Init` frame. The rules are the same on both:

- A refusal sends `{id: 0, err}` first, then closes:

  | Close | Meaning |
  |---|---|
  | 4401 | unauthenticated |
  | 4403 | forbidden |
  | 4400 | a malformed frame |
  | 4500 | the provider could not decide; retry, do not sign out |

- A later `Init` refreshes the credentials, and must name the same principal.
- The session closes with 4401 when the credential's `exp` passes. A WebSocket always did; WebTransport does too *(since 0.20.5, [cratestack#1381](https://github.com/cratestack/cratestack/issues/1381))*.
- Origins are same-origin by default (`OriginPolicy`).
- Limits per socket and per principal are configuration (`WebSocketLimits`,
  `WebTransportLimits`), never schema syntax.
- Opens can be rate limited *(since 0.19.3)*: `.rate_limit(layer.for_subscriptions())` on `WebSocketConfig`
  or `WebTransportConfig` charges one token per subscription `Request`. A throttled open is an `err` frame
  with `resource_exhausted` and `details.retry_after_secs`, and the socket stays open. SSE opens are charged by
  `RateLimitLayer` already. See [Rate limiting](./rate-limiting#subscriptions).

## Ending a stream when its principal is revoked

*(since 0.20.5, [cratestack#1381](https://github.com/cratestack/cratestack/issues/1381))*

A stream authenticates once, at open. Until 0.20.5 only its credential's `exp` ended it, so a device revoked a minute later kept receiving events. Now your app tells the server, and every stream and socket session of that principal ends, on every binding (SSE, cbor-seq, WebSocket, WebTransport), REST and RPC alike. Nothing changes until you call it: the default registry never revokes.

The generated runtime carries one registry, `StreamRevocations`. Read it with `db.stream_revocations()`, or give your own with `Cratestack::builder(..).with_stream_revocations(registry)`. On a `db = None` schema it exists only when the schema declares a `topic` or a `subscription procedure`.

```rust
// In the logout handler:
let ended = db.stream_revocations().revoke(
    RevocationKey::Session(sid),
    StreamEndReason::SessionEnded,
    Some(exp), // the latest `exp` a cached context could still carry
);
```

`revoke(key, reason, until)` ends every live stream and socket session that holds `key` and returns how many it ended. A stream that already has an end reason keeps its first one.

### Keys

A stream is held under the keys of the context that opened it.

| Key | Names | Revoke it for |
|---|---|---|
| `RevocationKey::Subject(String)` | the principal, `ctx.subject()` | a suspension: every session of one user |
| `RevocationKey::Session(String)` | one login session, the `sid` claim | a logout |
| `RevocationKey::Signer([u8; 32])` | the thumbprint of the key that signed the open | one enrolled device |
| `RevocationKey::Custom(String)` | anything your app keys by | whatever you choose |

`default_revocation_keys` reads the subject, a `sid` claim **only when it is a string**, and the signer thumbprint of a [signed open](./signed-transport). `sid` is not a reserved claim, so if your session id lives under another name, replace the function with `registry.with_keys(my_keys)`. It takes a `fn(&CratestackContext) -> Vec<RevocationKey>` and applies to streams and socket sessions alike, so a stream and the socket it rides on never disagree.

### Tombstones

`until` keeps a tombstone: until then the key is refused for **new stream opens and new socket `Init`s**, so a context your server still has cached cannot reopen what you just ended. Set it to the latest `exp` such a context could carry. `None` ends live streams only.

Tombstone only with a terminal reason: `session_ended`, `principal_suspended`, `device_revoked` (or `credential_expired`). `revoke` or `publish` with `stream_lifetime` or `revocation_resync` ends the live streams but keeps **no** tombstone, with a `warn!` log, because clients retry those two reasons without a cap and would reconnect until the tombstone lapsed. *(Since 0.20.5.)*

A tombstone does not refuse unary calls. Refusing those for a revoked principal stays the [`AuthProvider`](./auth-provider)'s job. A flood of revocations is bounded by `with_max_tombstones(n)` (default 100,000, `DEFAULT_MAX_TOMBSTONES`); over the cap, the tombstone that lapses soonest is dropped first, with a `warn!` log.

The order inside a stream is revocation first, then the credential clock, then items. A socket `Init` refresh re-registers the session but does not extend streams already open, and a revoke that lands mid-refresh still ends the session.

### Across replicas

`revoke` acts on one replica. To reach the others, publish over the [subscription backplane](#every-replica-sees-every-event) and have every replica follow:

```rust
// Every replica, once at startup:
tokio::spawn(db.stream_revocations().follow(backplane.clone()));

// The handler that revokes:
db.stream_revocations()
    .publish(&*backplane, RevocationKey::Subject(user), StreamEndReason::PrincipalSuspended, Some(exp))
    .await?;
```

`publish` revokes on this replica, then sends the revocation on the `cratestack.revocation` channel (`REVOCATION_CHANNEL`, server-internal JSON, never part of the client wire). The local revoke is not undone: if the backplane send fails, `publish` returns `Err` with the local streams already ended and the tombstone kept, and only the other replicas missed it, so retry. A replica that is not following never hears it. With `PgNotifyBackplane` you can issue the same `NOTIFY` in the transaction that records the change. Its payload is JSON `{"kind", "key", "reason", "until"}`, and `until` is **integer seconds since the epoch**: a fraction (what `extract(epoch from ...)` yields) or a numeric string is accepted and rounded up, so a tombstone never lapses early. *(Since 0.20.5.)*

Delivery is **at most once**, like the backplane. When the feed says messages may have been lost (`Resync`, `Lagged`, or the listener dropping), the follower applies a `ResyncPolicy` and subscribes again:

| `ResyncPolicy` | Effect |
|---|---|
| `EndAll` (default) | every watched stream ends with `revocation_resync`: no stream is trusted when a revocation may have been lost |
| `Ignore` | streams stay; a lost revocation goes unnoticed until the stream's `exp` or lifetime |

`follow(backplane)` is `follow_with(backplane, ResyncPolicy::EndAll)`; pass `ResyncPolicy::Ignore` to `follow_with` where a flapping `LISTEN` costs more than that window. A revoke lost *without* a gap signal is missed the same way.

A payload cannot end the follower. The revoke always applies. Only an `until` no `SystemTime` can hold is clamped to now + 24 h; a negative, NaN or non-numeric `until` revokes with no tombstone, with a `warn!` log; a malformed payload is skipped with a `warn!` log; a `reason` this version does not know (a newer replica, mid-rollout) still revokes the key, as `session_ended`, with a warning. However the follower ends, it applies its `ResyncPolicy` last, so with `EndAll` every watched stream ends with `revocation_resync` rather than staying trusted with nothing listening. If `follow` returns an error (it could not subscribe), spawn it again after a pause.

A hand-written `SubscriptionDispatcher` gets none of this, as with expiry.

### What the client sees

The stream ends with a terminal `err` frame whose `details` is `{"reason": "<name>"}`. The two ends that existed before keep their code and message byte for byte, so an older client reads them as it always did.

| `details.reason` | Code | Meaning | What the client does |
|---|---|---|---|
| `credential_expired` | `unauthenticated` 401 | the credential's `exp` passed | refresh the credential, then resubscribe |
| `stream_lifetime` | `unavailable` 503 | a signed open reached `max_signed_stream_life` | resubscribe, with a jittered backoff |
| `session_ended` | `unauthenticated` 401 | the login session ended | sign in again; never retry on its own |
| `principal_suspended` | `permission_denied` 403 | the principal was suspended | never retry |
| `device_revoked` | `permission_denied` 403 | the device key that signed the open was revoked | re-enrol; never retry |
| `revocation_resync` | `unavailable` 503 | the revocation feed lost messages | resubscribe, with a jittered backoff |

A refusal at open (a tombstoned key) is an ordinary error of the call with the same code and reason, before `Ready`.

A WebSocket or WebTransport session that ends this way sends its own `{id: 0, err}` frame, then closes by the code's status. On a revocation or expiry, each open subscription first gets its own `err` frame with the reason (WebSocket: one per subscription, in id order; WebTransport: one on each stream), so none of them sees a bare close. The close codes are: **4401** for 401, **4403** for 403, **4500** for 503. 4500 means retry, do not sign out.

The reason list will grow, so every reader treats a name it does not know as no reason and falls back to the code.

## Clients

The call is the same in every language. It resolves, or starts emitting, after Ready. A refusal
is an error of the call, never an item.

**Rust** (`include_server_schema!` or `include_client_schema!`):

```rust
let config = ClientConfig::new(base).with_subscription_transport(SubscriptionTransport::Auto);
let client = cratestack_schema::client::Client::new(CratestackClient::cbor(config));
let mut notes = client.notes().subscribe(&Default::default()).await?;
while let Some(event) = notes.recv().await { let event = event?; /* ModelEvent<Note> */ }
```

`Auto` tries each binding the build has, in order, and moves on only when one cannot be opened:

1. WebTransport, with the `client-webtransport` feature and the listener named in the config.
2. A WebSocket, with the `client-ws` feature.
3. SSE.

`SubscriptionTransport::WebTransport`, `WebSocket`, `Sse` and `CborSeq` *(since 0.20.3)* each pin one binding.
`Auto` never picks `CborSeq`.

Both features are native-only. On `cratestack-client` they are named `webtransport` and `ws`.

```rust
let config = ClientConfig::new(base).with_webtransport(
    "https://api.example.com:4433/rpc/wt".parse()?,
    ServerTrust::NativeRoots, // or CertificateHashes(vec![dev_cert.sha256]) in development
);
```

A WebTransport session that is not open within 3 s counts as unreachable, and that is
remembered for 10 minutes, so a UDP-blocked network pays the wait once.

The client reads a WebSocket or WebTransport item the way a unary CBOR call is read, so a `Uuid` field
decodes from its byte string *(since 0.19.6)*. It still reads an older server's text
`Uuid`s, but a client from before this change cannot read a newer server's model events over those two
bindings: upgrade them together, or pin `SubscriptionTransport::Sse` meanwhile. A partial model event
(`fields`) read as `ModelEvent<serde_json::Value>` fails on a `Uuid` field over a socket; read it into a
struct of `Option<_>` fields instead, or use SSE.

If you implement `SubscriptionDispatcher` by hand, `open(request, codec)` now takes the binding's codec
and yields `SubscriptionStream<RpcFrameValue>`, and `ServerFrame::next` / `ClientFrame::request` take
`impl Into<RpcFrameValue>`. Encode each item with `RpcFrameValue::encode_with(&codec, &item)`, or yield
`serde_json::json!(..).into()`.

**TypeScript** (both REST and RPC packages):

```ts
const client = new CratestackClient("https://api.example.com", {
  headers: { authorization: `Bearer ${token}` },
  subscriptions: { webTransport: { url: "https://api.example.com:4433/rpc/wt" } },
});
for await (const event of client.notes.subscribe({ operations: ["created"] }, { signal })) {
  render(event.data);
}
```

`"auto"` (the default) tries three bindings in order:

1. WebTransport, when you name its URL and the browser supports it.
2. A shared WebSocket.
3. SSE over `fetch`.

`subscriptions: { transport: "webtransport" | "websocket" | "sse" | "cbor-seq" }` pins one binding;
`"cbor-seq"` *(since 0.20.3)* is never chosen by `"auto"`. A WebTransport attempt that is not ready within 3 s is remembered for 10 minutes, so a UDP-blocked
network pays that wait once. Breaking out of the loop, or aborting `signal`, cancels the
subscription. Each hook layer wraps any subscription:

- `--swr`: `useSubscription(key, (signal) => client.notes.subscribe({}, { signal }))`, over
  `swr/subscription`.
- `--tanstack`: `useSubscriptionQuery(key, open, { onItem })`. The query's `data` is the latest
  item, and the subscription ends when the query's last observer unmounts. To keep a list fresh,
  invalidate its key in `onItem`.

**Dart**: a `Stream`, over SSE through the same `CratestackHttpTransport` every call uses:

```dart
client.notes.subscribe(onReady: () => setState(() => live = true)).listen(render);
```

With `--preset riverpod` (or `fespalier`), each op also gets a stream provider:
`ref.watch(noteEventsProvider(input: ...))` for a model feed, and `ref.watch(linesProvider(args))`
for a subscription procedure. Watching an equal input reuses the same subscription.

The Dart client also speaks a WebSocket, on native and web, and WebTransport, on Flutter web
only. Pass `CratestackSubscriptionOptions` to the client as `subscriptions:`. In the riverpod preset,
override `<prefix>SubscriptionOptionsProvider` instead.

```dart
final client = MyCratestackClient(
  adapter,
  subscriptions: CratestackSubscriptionOptions(
    credentials: () => {'authorization': 'Bearer $token'},
    webTransportUrl: Uri.parse('https://api.example.com:4433/rpc/wt'), // web only
  ),
);
```

`auto` tries WebTransport, then the WebSocket, then SSE, and never `CratestackSubscriptionTransport.cborSeq`
*(since 0.20.3)*, which you pin with `transport:`. A socket does not go through your HTTP
transport, so it cannot carry the token a Dio interceptor adds. `credentials` supplies the headers
the socket sends instead. Until you set it, `auto` stays on SSE.

`examples/realtime-chat` in the framework repository puts all of this together. It has a model
feed, a topic behind a subscription procedure, and all three bindings. Its test proves in Chromium
that `"auto"` uses WebTransport with UDP open and falls back to the WebSocket with UDP blocked.

### Reading why a stream ended

*(since 0.20.5, [cratestack#1381](https://github.com/cratestack/cratestack/issues/1381))*

Each client reads `details.reason` of the terminal `err` frame, and of the `{id: 0, err}` frame a closed socket session sends, on REST and RPC over every binding.

| Client | Reader |
|---|---|
| Rust | `ClientError::stream_end_reason() -> Option<StreamEndReason>`. `None` for a refusal, an end without a reason, or a reason this client does not know. Match with a wildcard arm: `StreamEndReason` is `#[non_exhaustive]`. |
| TypeScript | `CratestackSubscriptionError.endReason`, typed by the exported `StreamEndReason` union (`undefined` when absent or unknown). Helpers: `isTerminalEndReason(reason)`, `shouldResubscribe(error)` and `resubscribeDelayMs(attempt)` (full jitter, capped at 30 s). |
| Dart | `CratestackSubscriptionException.endReason`, a `CratestackStreamEndReason` (`null` for none, `unknown` for a name a newer server sent), with `isTerminal` and `resubscribes`. |

```rust
while let Some(event) = notes.recv().await {
    match event {
        Ok(event) => render(event),
        Err(error) => match error.stream_end_reason() {
            Some(StreamEndReason::DeviceRevoked) => re_enrol(),
            Some(StreamEndReason::SessionEnded) => sign_in_again(),
            _ => { /* decide by the code, as before */ }
        },
    }
}
```

The retry helpers apply the table above for you:

- **Riverpod** (`--preset riverpod`): `cratestackSubscriptionRetry` never retries `session_ended`, `principal_suspended` or `device_revoked`. It retries `stream_lifetime` and `revocation_resync` with the default backoff, jittered, and never gives up on them (the count that sizes the backoff is clamped to 5). `credential_expired` keeps the default retry, since only your app can refresh the credential.
- **`--tanstack`**: `useSubscriptionQuery` retries `stream_lifetime` and `revocation_resync` with a jittered delay and no cap on the count, and nothing else. It used to set `retry: false`.
- **`--swr`**: `useSubscription` reopens those two ends after a jittered backoff and surfaces every other end as `error`, as before.

A session's `{id: 0, err}` is the terminal error of every subscription open on that socket. The Rust WebSocket client, the TypeScript socket runtime (for every open subscription, and for any opened later on that dead socket) and the Dart socket reader hand it to each one with its code, message and `details.reason`, so a stream a revoke ended is not mistaken for a dropped socket and resubscribed.

A client that never reads the reason keeps working: the code and message are the ones it knew.

### Bounding one SSE event

*(since 0.20.2, [cratestack#1379](https://github.com/cratestack/cratestack/issues/1379))*

An SSE reader buffers bytes until it sees the blank line that ends an event. A server (or an
intermediary) that never sends it would grow the client's memory until the process dies, so every
client caps one event at **1 MiB**. Rust counts the raw bytes received, line endings and the blank line included; TypeScript and Dart count UTF-8 bytes after `\r\n` is normalized to `\n`, so they may accept up to one more byte per line (the bound is still linear in the cap). A longer event ends the
subscription with a typed error, and the connection is dropped. Nothing after it is delivered. The
cap counts the partial `data:` lines and the unfinished line too, so one endless line with no
newline is refused, not only many lines.

| Client | Set it | The error |
| --- | --- | --- |
| Rust | `ClientConfig::new(base).with_max_sse_event_bytes(n)` | `ClientError::EventTooLarge { limit }` |
| TypeScript | `subscriptions: { maxEventBytes: n }` | `CratestackEventTooLargeError`, code `event_too_large`, `.limit` |
| Dart | `CratestackSubscriptionOptions(maxEventBytes: n)` | `CratestackEventTooLargeException`, code `event_too_large`, `.limit` |

Raise the cap only if one frame can legitimately be larger than 1 MiB. The WebSocket and
WebTransport bindings are not governed by this setting. The `application/cbor-seq` binding is: see
[Subscribing over `application/cbor-seq`](#subscribing-over-application-cbor-seq). A refused event is not retried by the client, and `Auto`
does not fall back to another binding on it. A `ready` event over the cap refuses the open with the same typed error. On the Rust RPC client it is `RpcClientError::EventTooLarge { limit }` (not `InvalidResponse`). In the Dart `--preset riverpod` stream providers, Riverpod 3 retries a failed provider (up to 10 times, with backoff) unless the error is an `Error` or `ProviderException`; the generated providers pass `retry: cratestackSubscriptionRetry`, which defers to Riverpod's `ProviderContainer.defaultRetry` and opts `CratestackEventTooLargeException` out of that retry (it reaches the provider as an `AsyncError` at once; `ref.invalidate` retries by hand) and keeps the default for every other error.

### Subscribing over `application/cbor-seq`

*(since 0.20.3, [cratestack#1001](https://github.com/cratestack/cratestack/issues/1001))*

The SSE routes also answer `Accept: application/cbor-seq`. The body is a CBOR sequence of the frames SSE
carries, CBOR-encoded, so items arrive in their CBOR shapes, as on a unary CBOR call: a `Uuid` is a byte string. Use it when the client speaks only CBOR, or sits behind a proxy that mangles
`text/event-stream`.

**The server picks the binding from `Accept`.** `application/cbor-seq` selects cbor-seq; `text/event-stream`
and `*/*` select SSE. Entries are matched literally and **the first entry the server speaks wins**:
`application/cbor-seq, text/event-stream` is cbor-seq, `text/event-stream, application/cbor-seq` is SSE. A
missing or unacceptable `Accept` is `406 not_acceptable` before authentication. The message changed to
`subscription endpoint requires Accept: text/event-stream or application/cbor-seq`, so match on the status or
the code, not the text. A refusal before the stream (bad auth, policy, a bad body) is the same JSON error
body as for SSE, with its own status. Every response the generated subscribe handler makes carries
`Vary: Accept`, set once by the handler, so a cache keeps the two bindings of one URL apart. A compact answer
(`application/vnd.cratestack.compact+…`) adds its own second `Vary` line naming `Cratestack-Contract`, which caches
combine. That covers success on both
bindings and every refusal the handler itself makes: the `406`, auth refusals, the RPC `POST` body `400` and an
unknown op. A refusal from a layer in front of the handler does not carry it: the `413` body limit, a `405`, a
path rejection, the rate-limit `429` or an envelope-layer error. `Accept` matching is literal: q-values are
not parsed.

**Framing.** Each item is one CBOR `ServerFrame`:

| Item | Meaning |
| --- | --- |
| `{id: 1, ready: {}}` | first; the subscription is live |
| `{id: n, next: <item>}` | one per event; `n` counts up from 2, as on SSE. The ids count up per frame; WebTransport instead carries one subscription id on every frame |
| `{id, err}` or `{id, end: {}}` | exactly one terminal frame. A model feed's overflow is `err` with `unavailable`. `end` is sent when the source simply ends (SSE sends nothing then) |
| `null` (`0xf6`) | the keep-alive, every 15 s while nothing is due. Not a frame |

The response is `Content-Type: application/cbor-seq` (the existing `cratestack::CBOR_SEQUENCE_CONTENT_TYPE`,
exported at the crate root on both the `cratestack-pg` and `cratestack-api` facades, not under `cratestack::rpc`; no new
constant). The binding items are under `cratestack::rpc`: `SubscribeBinding`, `SubscribeCodec`,
`decode_subscribe_open_body` and `encode_subscription_cbor_seq_response`.

**Routes.** All four generated subscribe routes get it: `GET` and `POST /rpc/subscribe/<op>`,
`GET /$procs/<name>` and `GET /<plural>/$subscribe`. REST has no `POST` subscribe form, for SSE or for cbor-seq.
`POST /rpc/subscribe/<op>` now reads its open body by `Content-Type`: `application/cbor` is CBOR, anything
else (or none) is JSON. The bounds are SSE's: the credential-expiry cut-off and the open rate limit apply. The
per-principal session cap (`SessionRegistry::admit`) is used only by the WebSocket and WebTransport bindings,
so cbor-seq does not use it, as SSE does not.

**Clients opt in; `Auto` never picks it.** A body that ends inside a frame, or between frames without `end` or
`err`, is an error in every client, never a quiet end, because the server always sends a terminal frame. One
frame is capped by the same per-event cap as SSE (1 MiB by default).

| Client | Pin it | Cap | Needs |
| --- | --- | --- | --- |
| Rust | `ClientConfig::new(base).with_subscription_transport(SubscriptionTransport::CborSeq)` | `with_max_subscription_frame_bytes(n)` (the same setting as `with_max_sse_event_bytes`) | nothing extra |
| TypeScript | `subscriptions: { transport: "cbor-seq" }` | `maxEventBytes` | `@cratestack/cbor`, loaded on first use (a dependency of an RPC package, an optional peer of a REST one; without it on a REST package the subscription fails with `CratestackSubscriptionError` code `codec_unavailable` before any request is sent) |
| Dart | `CratestackSubscriptionOptions(transport: CratestackSubscriptionTransport.cborSeq)` | `maxEventBytes` | nothing extra (the generated `cratestack_cbor` codec) |

**What a client refuses.** Before the first frame a client checks the response `Content-Type` is
`application/cbor-seq` (parameters ignored, case-insensitive), and that the stream opens with `ready`. If `err`
comes first, that is the server's refusal and the error carries the server's code. If `end` or `next` comes
first, or an item is not a map, the response is invalid. A stream that ends without `end` or `err` is an error.
All of these are `ClientError::InvalidResponse` (Rust), a `CratestackSubscriptionError` with code
`invalid_response` (TypeScript) or a `CratestackSubscriptionException` with code `invalid_response` (Dart).

**Model event ids.** A model event's `event_id` travels as a 16-byte CBOR byte string on cbor-seq. The
TypeScript and Dart clients revive it to the canonical hyphenated UUID string (`ModelEvent.event_id`,
`CratestackModelEvent.eventId`); in Rust `ModelEvent.event_id` is a `Uuid`.

Over the cap the error is `ClientError::EventTooLarge`, `CratestackEventTooLargeError` or
`CratestackEventTooLargeException`, as for SSE. A truncated or unterminated stream is
`ClientError::InvalidResponse` (Rust), a `CratestackSubscriptionError` with code `invalid_response`
(TypeScript) or a `CratestackSubscriptionException` with code `invalid_response` (Dart).

::: warning Breaking for exhaustive matches
`SubscriptionTransport` (Rust) and `CratestackSubscriptionTransport` (Dart) each gained a variant. An
exhaustive `match` or `switch` needs a new arm. A generated TypeScript package also emits `src/cbor-item.ts`
and `src/cbor-argument.ts` when a REST schema has a subscription, as an RPC package already did.
:::

## Deploying WebTransport

WebTransport is HTTP/3, so it is UDP, normally on the same port number as HTTPS, in the same
process as your axum server. Your load balancer must forward UDP (L4) to it. To keep sessions
across a client's network change, it must route by QUIC connection ID. Keep the WebSocket or SSE
fallback reachable for networks that block UDP. The full checklist is §6a.6 of the design.

## Read next

- [RPC transport](./rpc-transport): the op ids and the `/rpc/subscribe` endpoint in context.
- [AuthProvider](./auth-provider): what authenticates a subscription, on every binding.
- [TypeScript client generation](./typescript-client-generation) and
  [Dart client generation](./dart-client-generation).
