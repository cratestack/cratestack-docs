---
title: RPC transport
description: Pick `transport rpc` in your `.cstack` schema to swap REST routes for `POST /rpc/{op_id}` + `POST /rpc/batch`. Unary, batch, and streaming work today; WebSocket + subscriptions are designed but not yet built.
---

# RPC transport

CrateStack ships **two generation styles** for a `.cstack` schema. The default is REST — per-model `/users`, `/users/{id}`, `/$procs/<name>` routes, the shape this framework was built around. The alternative is **RPC** — a single `POST /rpc/{op_id}` route per callable, a `POST /rpc/batch` endpoint that takes N frames at a time, and content-negotiated streaming on the same unary route. One binding per schema; the macro emits exactly one binding's worth of routes and client surface. There is no runtime flip and no schema runs both.

This guide covers what the RPC binding does today and when to pick it. The full design is in [ADR 0005](../internals/rpc-transport-adr).

## Pick the binding

Declare the directive at the top of your `.cstack` file:

```cstack
transport rpc

datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

auth Operator {
  id Int
}

model Widget {
  id Int @id
  name String

  @@allow("read", auth() != null)
  @@allow("create", auth() != null)
  @@allow("update", auth() != null)
  @@allow("delete", auth() != null)
}

procedure ping(args: PingArgs): PingArgs
  @allow(auth() != null)
```

Omit the directive for REST behavior unchanged. Defaults preserve everything written before the directive existed.

## Mounting the router

`include_server_schema!` emits an `rpc_router(...)` builder when `transport rpc` is set, same shape as the existing `model_router` / `procedure_router`:

```rust
use cratestack::axum::Router;

let app: Router = cratestack_schema::axum::rpc_router(
    db,
    MyProcedures,
    CodecSet::new(CborCodec, JsonCodec),
    MyAuthProvider,
);
```

The router mounts two paths:

- `POST /rpc/{op_id}` — unary for every CRUD verb + every procedure
- `POST /rpc/batch` — sequence of `RpcRequest` frames

## Op identity

Every callable in a `transport rpc` schema gets a stable dotted id. The id is the only dispatch key and appears in the URL:

| Schema construct | Op id | Kind |
|---|---|---|
| `model Widget` | `model.Widget.list` | `Unary` |
| `model Widget` | `model.Widget.get` | `Unary` |
| `model Widget` | `model.Widget.create` | `Unary` |
| `model Widget` | `model.Widget.update` | `Unary` |
| `model Widget` | `model.Widget.delete` | `Unary` |
| `procedure ping(...)` | `procedure.ping` | `Unary` |
| `procedure manyPings(...): PingArgs[]` | `procedure.manyPings` | `Sequence` |

The op id appearing in the URL (not the body) is deliberate — it lets nginx, CDNs, and HTTP tracing tools route and instrument per-op without parsing payloads.

On `transport rpc` the op id is also the **canonical request identity** used for signature verification and tracing — not the REST shape. A signed RPC request must sign over the op id (`model.Widget.update`, `procedure.ping`), and the `cratestack_route` tracing field carries that same op id. The REST `/$procs/<name>` and `/<plural>[/<id>]` paths never appear on the RPC binding, for url, dispatch, signing, or logs. (On the REST binding the canonical stays the REST route path.)

## Unary

Body shape per verb:

```jsonc
// POST /rpc/model.Widget.create
// body = CreateWidgetInput directly (same as the REST POST body shape)
{ "name": "left handle" }

// POST /rpc/model.Widget.get  or  /rpc/model.Widget.delete
{ "id": 42 }

// POST /rpc/model.Widget.update
// patch decoded against the model's UpdateWidgetInput shape
{ "id": 42, "patch": { "name": "new name" } }

// POST /rpc/model.Widget.list
// mirrors the REST URL query 1:1 — same keys, same semantics
{
  "limit": 20,
  "offset": 40,
  "fields": ["id", "name"],
  "include": ["..."],
  "sort": "name desc",
  "where": "...",
  "filters": [{ "key": "active", "value": "true" }]
}

// POST /rpc/procedure.ping
// body = procedure Args directly
{ "args": { "nonce": "abc" } }
```

Response on success: the codec-encoded output directly (no envelope wrapper). Auth, codec negotiation, content-type rules — same as the REST binding.

## Batch — `POST /rpc/batch`

Send N requests in one round-trip, get N responses back **in the same order**:

```jsonc
// request body — a sequence of RpcRequest frames
[
  { "id": 1, "op": "procedure.ping",       "input": { "args": { "nonce": "a" } } },
  { "id": 2, "op": "model.Widget.create",  "input": { "name": "frame two" }, "idem": "client-key-7b3" },
  { "id": 3, "op": "model.Widget.get",     "input": { "id": 42 } }
]
```

```jsonc
// response body — a sequence of RpcResponseFrame, same order as the request
[
  { "id": 1, "output": { "nonce": "a" } },
  { "id": 2, "output": { "id": 17, "name": "frame two" } },
  { "id": 3, "error":  { "code": "not_found", "message": "widget 42" } }
]
```

Three deliberate behaviors:

1. **Per-frame errors don't poison the batch.** The envelope returns `200 OK` as long as the batch parsed; each frame's success or failure is on its own response frame.
2. **No transactional mode, no in-batch dependencies.** Each frame runs in its own transaction. A batch like `[create A, update B referencing A.id]` is not supported — use two roundtrips or a single `@procedure` that owns the composite operation.
3. **Per-frame idempotency only.** Send `idem` on each `RpcRequest`. The `Idempotency-Key` HTTP header is rejected on `/rpc/batch` as ambiguous.

A malformed batch envelope (body that isn't a sequence of frames) returns `400`.

## Streaming — `Accept: application/cbor-seq`

List-return procedures (those declared as `... : T[]`) get `OpKind::Sequence` from the macro and stream over the **same** `POST /rpc/{op_id}` route as unary. Switch by content negotiation:

```http
POST /rpc/procedure.manyPings HTTP/1.1
Content-Type: application/cbor
Accept: application/cbor-seq
```

The response is a stream of codec-encoded chunks, terminated by end-of-body. With the default Accept the same op returns a single CBOR `Vec<T>` — the route doesn't change, only the wire shape.

SSE (`text/event-stream`) is wired in the codec layer and works the same way for clients that need EventSource compatibility.

## Consuming streams

The wire side is one paragraph; the interesting question is what a client looks like on the other end of that pipe. CrateStack ships four client paths and you can pick per-app or per-request.

### The wire shape

`application/cbor-seq` is a sequence of self-delimiting CBOR top-level items concatenated back-to-back — no envelope, no length prefix, no framing bytes between items. The server emits it from `reqwest`/`axum`'s `bytes_stream()` so the body flushes as items are produced; the response is never fully buffered on the wire. The URL is the same `POST /rpc/{op_id}` that serves unary; only `Accept: application/cbor-seq` (the codec's `sequence_accept_header_value()`) flips the response shape. Op kind is decided by the schema (`OpKind::Sequence` for list-return procedures and the model `list` verb), not by the request.

### Path 1 — Rust client via `RpcClient::call_streaming`

The typed Rust path. The method returns a bounded `tokio::sync::mpsc::Receiver` so memory stays tight: 16 in-flight items max, with backpressure flowing back through reqwest's chunk stream when the consumer falls behind.

```rust
use cratestack::client_rust::rpc::{RpcClient, RpcClientError};

let mut rx = rpc_client
    .call_streaming::<TicksArgs, Tick>("procedure.ticks", &TicksArgs { count: 100 })
    .await?;

while let Some(item) = rx.recv().await {
    match item {
        Ok(tick) => render(tick),
        Err(RpcClientError::Remote(err)) => {
            // Per-item error — terminal. The next recv() will return None.
            eprintln!("server returned {}: {}", err.body.code, err.body.message);
            break;
        }
        Err(other) => {
            eprintln!("transport/decode error: {other}");
            break;
        }
    }
}
```

Two shape notes worth pinning down:

1. **Non-2xx responses surface before the channel opens.** `call_streaming` returns `Err(RpcClientError)` from its `await`, not as the first channel item. The channel exists only after the server has accepted the request and started streaming.
2. **Per-item errors are terminal.** Each `Err` in the channel is the last item; the pump task exits after sending it. Consumers don't need an inner loop guard — a single `while let Some(item) = rx.recv().await` covers happy path, transport mid-stream failure, and clean end-of-stream.

### Path 2 — Flutter via callback + frb `StreamSink`

The reqwest-in-Rust path for Flutter apps. `FlutterRuntime::rpc_call_streamed` takes a callback that returns `bool` (false cancels); the natural wrap with `flutter_rust_bridge` is a `StreamSink<FlutterChunkWire>` so Dart code consumes a regular `Stream`. The full Rust shim lives in [`cratestack-client-flutter/README.md`](https://github.com/cratestack/cratestack/blob/main/crates/cratestack-client-flutter/README.md); the gist:

```rust
use cratestack_client_flutter::{FlutterChunkWire, FlutterHeader, FlutterRuntime, FlutterRuntimeError};
use flutter_rust_bridge::frb;

#[frb(sync)]
pub fn rpc_call_streamed(
    runtime: &FlutterRuntime,
    op_id: String,
    input: Vec<u8>,
    headers: Vec<FlutterHeader>,
    sink: flutter_rust_bridge::StreamSink<FlutterChunkWire>,
) -> Result<(), FlutterRuntimeError> {
    runtime.rpc_call_streamed(&op_id, input, headers, move |chunk| sink.add(chunk).is_ok())
}
```

On the Dart side one `switch` over `FlutterChunkWire` covers every termination path:

```dart
await for (final chunk in stream) {
  switch (chunk) {
    case FlutterChunkWire_Item(:final field0):
      final tick = Tick.fromWire(cbor.cbor.decode(field0));
      renderRow(tick);
    case FlutterChunkWire_End():
      break;
    case FlutterChunkWire_Error(:final field0):
      handleError(field0);
      break;
  }
}
```

`Item` carries one CBOR-encoded item's raw bytes — decode it on the Dart side with the `cbor` package (or anything else that speaks CBOR). `End` and `Error` are both terminal: no further variants follow either.

### Path 3 — Flutter via dio + `CborSeqStreamTransformer`

For apps that want HTTP to live in Dart — native NSURLSession/OkHttp visibility, dio interceptors for auth/retry/idempotency, Flutter DevTools network inspection, system proxy and certificate pinning — the generated Dart RPC runtime ships two primitives:

- `CborSeqDecoderHandle` — abstract interface; `Future<List<Uint8List>> feed(Uint8List)` plus `int pendingLen()`. The FFI-backed `FlutterCborSeqDecoder` (from `cratestack-client-flutter`) satisfies it; pure-Dart impls work for web or server-side Dart.
- `CborSeqStreamTransformer` — a plain `StreamTransformer<Uint8List, Uint8List>` that wraps any decoder handle. Composes with anything that produces `Stream<Uint8List>`.

```dart
final decoder = FlutterCborSeqDecoder();
final response = await dio.post<ResponseBody>(
  '/rpc/$opId',
  data: encodedInput,
  options: Options(
    responseType: ResponseType.stream,
    contentType: 'application/cbor',
    headers: {'Accept': 'application/cbor-seq'},
  ),
);

final items = response.data!.stream
    .transform(CborSeqStreamTransformer(decoder))
    .map((bytes) => Tick.fromWire(cbor.cbor.decode(bytes)));

await for (final tick in items) renderRow(tick);
```

Interceptors plug in at the dio level, not at the transformer level — the streaming path looks the same whether you've stacked auth, retry, and idempotency or not:

```dart
final dio = Dio(BaseOptions(baseUrl: baseUrl))
  ..interceptors.add(InterceptorsWrapper(onRequest: (opts, h) {
    opts.headers['Authorization'] = 'Bearer ${currentToken()}';
    opts.headers.putIfAbsent('Idempotency-Key', () => const Uuid().v4());
    h.next(opts);
  }))
  ..interceptors.add(RetryInterceptor(dio: dio, retries: 3)); // dio_smart_retry
```

Errors flow through Dart's normal stream error channel: decoder exceptions propagate as the underlying type; a stream that closes mid-frame raises a `FormatException`. Cancellation through `subscription.cancel()` propagates upstream into dio's request cancellation contract.

### Path 4 — TypeScript via `runtime.stream(...)` + `RpcStreamLink` chain

The browser/Node path, entirely in TypeScript — no Rust FFI in the loop at all. `cratestack generate-typescript` emits `CratestackRpcRuntime.stream()` for every RPC schema (both the `default` and `swr` output presets), backed by `fetch()`'s native streaming body reader and the same boundary-scan logic as the other three paths, reimplemented in TypeScript rather than shared through FFI.

```ts
import { ExampleWidgetClientClient, CratestackRpcStreamError } from "@example/widget-client";

const client = new ExampleWidgetClientClient("https://api.example.com", { basePath: "/api" });

try {
  for await (const tick of client.runtime.stream<Tick>("procedure.ticks", { count: 100 })) {
    renderRow(tick);
  }
} catch (error) {
  if (error instanceof CratestackRpcStreamError) {
    // Mid-stream sentinel (tag 48900) — the stream ends here either way.
    handleError(error.body);
  } else {
    // Transport failure: network error, malformed/truncated cbor-seq body.
    throw error;
  }
}
```

`stream()` negotiates `Accept: application/cbor-seq, <configured codec>` on every call. When the server picks the configured codec (the common case for a small/finite result), the body is a single encoded array, decoded and yielded in one go. When the server picks `application/cbor-seq` for a genuinely-incremental `@stream` procedure, a `CborSeqBoundaryScanner` reads the response body's `ReadableStream` chunk by chunk and yields each self-delimiting CBOR item as soon as its bytes are complete — never after buffering the whole response. A tag-48900 item ends the iteration by throwing `CratestackRpcStreamError` instead of yielding one more item; any other transport failure (a dropped connection, a truncated final item) throws `CratestackRpcTransportError` instead.

Unlike `call()`/`batch()`, `stream()` doesn't reuse the `RpcLink` chain — a `Response`-shaped link contract can't work for streaming (a link wanting to retry would need to clone an already-streaming body, defeating the point). Streaming links are shaped as async generators instead, via a separate `streamLinks` option:

```ts
// createLoggerStreamLink is generated alongside the runtime (src/links.ts)
// and re-exported from the package root, same as the runtime class itself.
import { ExampleWidgetClientClient, createLoggerStreamLink } from "@example/widget-client";

const client = new ExampleWidgetClientClient("https://api.example.com", {
  streamLinks: [createLoggerStreamLink()],
});
```

A stream link consumes the `AsyncIterable<RpcStreamFrame>` its `next` hands it and yields its own frames onward — `{ kind: "output", output }` for a decoded item, `{ kind: "error", error }` for the mid-stream sentinel — so a link author checks `frame.kind` rather than catching an exception. `links`/`streamLinks` are two separate chains on the same `CratestackRpcRuntime`; passing neither is a true no-op on both. See the [TypeScript client generation guide's "Composable links" section](/guides/typescript-client-generation#composable-links-cratestack) for the `@cratestack/*` package family that ships ready-made links (batching, logging) for the `links` chain — as of this writing that family doesn't yet ship a published `streamLinks` link, so a custom one (or the generated reference `createLoggerStreamLink`) is the starting point today.

### Pick one

| Path | Shape on the consumer side | When to pick |
|---|---|---|
| Rust `RpcClient::call_streaming` | `Receiver<Result<O, RpcClientError>>` | Rust server-to-server, Rust CLIs, anything where the consumer is Rust. Bounded mpsc gives backpressure for free. |
| Flutter `FlutterRuntime::rpc_call_streamed` + frb `StreamSink` | `Stream<FlutterChunkWire>` in Dart | Flutter apps that are fine with one HTTP stack (reqwest in Rust); items decode Dart-side. |
| dio + `CborSeqStreamTransformer` + `FlutterCborSeqDecoder` | `Stream<Uint8List>` in Dart | Flutter apps that want native HTTP visibility, dio interceptors, or Flutter DevTools network inspection. HTTP lives in Dart; only frame-boundary detection lives in Rust. |
| TypeScript `runtime.stream(...)` + `streamLinks` | `AsyncIterable<O>` in TypeScript | Browser and Node consumers of a `transport rpc` schema — the generated web/Node client, no Rust or Dart toolchain involved. |

For a worked end-to-end Rust example see [`examples/rpc-streaming-client-rust`](https://github.com/cratestack/cratestack/tree/main/examples/rpc-streaming-client-rust). For the three-crate client split see [Client Runtime](../architecture/client-runtime); for the framing decisions see [ADR 0005 §3.3](../internals/rpc-transport-adr).

## Errors — uniform `RpcErrorBody` shape

Every error on the RPC binding — whether raised inside the dispatcher (decode failure, unknown op id) or inside a handler (auth denied, not found, validation failed) — wire-shapes as:

```jsonc
{
  "code": "not_found",
  "message": "widget 42",
  "details": null
}
```

The `code` field uses **gRPC-style lowercase strings**: `not_found`, `invalid_argument`, `permission_denied`, `failed_precondition`, `conflict`, `unauthenticated`, `internal`. Never the REST binding's `SCREAMING_CASE` (`NOT_FOUND`, `FORBIDDEN`, …).

HTTP status codes match the error category. Clients that catch by status work unchanged from REST; clients that parse the body get a stable string vocabulary.

## When to pick RPC

| You want | Pick |
|---|---|
| Cacheable GETs, per-route metrics, REST tooling ecosystem | `transport rest` |
| Multi-op batching in one round-trip | `transport rpc` |
| One uniform error vocabulary across every op | `transport rpc` |
| List/audit/feed streaming with a single content-type flip | Either — REST and RPC both serve `application/cbor-seq` on list-return shapes |
| Subscriptions / push channels | Neither yet (see below) |
| Server-to-server only, prefer one consistent op-id namespace | `transport rpc` |
| Public API that benefits from HTTP-native caching at a CDN | `transport rest` |

Schemas can't switch styles without migrating clients, so pick deliberately. If you're unsure, REST is the back-compat default.

## What's not yet built — WebSocket + subscriptions

The HTTP surface of the RPC binding is feature-complete. The remaining direction is a **WebSocket binding** that would unlock subscriptions — `model.<X>.subscribe` ops that stream `ModelEvent<X>` frames over a long-lived channel. The wire-side design is captured in [ADR 0005 §3.4](../internals/rpc-transport-adr); the runtime work is gated on a concrete subscription use case.

Streaming shipped without ceremony because the shape was concrete — list-return procedures, audit feeds, paginated reads, all naturally producing finite sequences with an existing encoder ready to go. Subscriptions don't have that profile yet: CrateStack's audit and event-bus consumers today are server-to-server and poll or consume from the audit sink. External clients are the natural fit, but no concrete CrateStack consumer is asking for subscriptions right now. **When a concrete use case appears, the WS binding becomes the next cool upgrade.** Until then, the gap is deliberate.

## Read Next

1. [ADR 0005: RPC Binding for `transport rpc` schemas](../internals/rpc-transport-adr) — the canonical design, including the design decisions made along the way (URL routing, dispatcher delegation, error wire shape) and the deferred items.
2. [Transport architecture](../architecture/transport-architecture) — the codec / framing / envelope model that both bindings sit on top of.
3. [Idempotency](./idempotency), [Batches](./batches) — closely related primitives that work the same way on either binding.
