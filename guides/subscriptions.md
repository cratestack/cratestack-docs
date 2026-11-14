---
title: Subscriptions
description: Live data from a CrateStack server — model feeds (`@@subscribe`), subscription procedures and topics — over SSE, WebSocket or WebTransport, with the read policy applied to every event, and typed Rust, TypeScript and Dart clients.
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
`@isolation`, `@no_idempotency`, `@status`, `@no_rate_limit` or `@mcp`. It works under
`db = None` too, with your own stream as the source.

Topics work under `db = None` as well, on `cratestack-api`: the same `db.topics().room_tick(&id)`
with `publish` and `subscribe`, but no `publish_in_tx`, since there is no transaction; publish once
the work is done. The default backplane is an `InProcessBackplane` shared by every
`Cratestack::builder().build()` of the schema in the process, so it reaches one replica only. To reach
others, pass your own `SubscriptionBackplane` with `Cratestack::builder().with_backplane(Arc::new(..))`.
A `db = None` schema that declares a topic has a `Cratestack` that is `Clone` but not `Copy`.

## Every replica sees every event

Events reach subscribers through the **subscription backplane**. The default,
`PgNotifyBackplane`, uses Postgres `LISTEN`/`NOTIFY`, and the writing transaction itself
notifies. A subscriber on replica B therefore sees a write committed on replica A, in commit
order, and only if it committed.

When the listener reconnects, events may have been lost, so every subscription on that replica
ends with `unavailable` / `"subscription interrupted"`. Behind PgBouncer in transaction mode,
`LISTEN` does not work. In that case, run a single replica with
`Cratestack::builder(pool).with_backplane(Arc::new(cratestack::InProcessBackplane::new()))`.

## The bindings

| Binding | Where | Frames | When |
|---|---|---|---|
| SSE | `/rpc/subscribe/<op>` (`GET` with the input as the query, or `POST` with a JSON body); REST `GET /<plural>/$subscribe`, `GET /$procs/<name>` | `event: ready`, `event: message`, one `event: error`; `: keepalive` every 15 s; JSON | everywhere |
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
- The session closes with 4401 when the credential's `exp` passes.
- Origins are same-origin by default (`OriginPolicy`).
- Limits per socket and per principal are configuration (`WebSocketLimits`,
  `WebTransportLimits`), never schema syntax.
- Opens can be rate limited *(since 0.19.3)*: `.rate_limit(layer.for_subscriptions())` on `WebSocketConfig`
  or `WebTransportConfig` charges one token per subscription `Request`. A throttled open is an `err` frame
  with `resource_exhausted` and `details.retry_after_secs`, and the socket stays open. SSE opens are charged by
  `RateLimitLayer` already. See [Rate limiting](./rate-limiting#subscriptions).

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

A WebTransport attempt that is not ready within 3 s is remembered for 10 minutes, so a UDP-blocked
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

`auto` tries WebTransport, then the WebSocket, then SSE. A socket does not go through your HTTP
transport, so it cannot carry the token a Dio interceptor adds. `credentials` supplies the headers
the socket sends instead. Until you set it, `auto` stays on SSE.

`examples/realtime-chat` in the framework repository puts all of this together. It has a model
feed, a topic behind a subscription procedure, and all three bindings. Its test proves in Chromium
that `"auto"` uses WebTransport with UDP open and falls back to the WebSocket with UDP blocked.

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
