---
title: RPC transport
description: Pick `transport rpc` in your `.cstack` schema to swap REST routes for `POST /rpc/{op_id}` + `POST /rpc/batch`. Unary, batch, and streaming work today, along with a composable `RpcLink` client middleware chain and `@cratestack/api`'s automatic batch-coalescing link; WebSocket + subscriptions are designed but not yet built.
---

# RPC transport

A `.cstack` schema's `TransportStyle` has two variants — REST and RPC. The default is REST — per-model `/users`, `/users/{id}`, `/$procs/<name>` routes, the shape this framework was built around. This guide covers the second style, **RPC** — a single `POST /rpc/{op_id}` route per callable, a `POST /rpc/batch` endpoint that takes N frames at a time, and content-negotiated streaming on the same unary route. One binding per schema; the macro emits exactly one binding's worth of routes and client surface. There is no runtime flip and no schema runs both.

<Note>
There used to be a third variant. **Protobuf/gRPC support was removed in
0.8.5** ([ADR 0017](https://github.com/cratestack/cratestack/blob/main/docs/adr/0017-remove-grpc-protobuf.md));
`transport grpc` and the `@pb` attribute no longer parse at all. A schema
still declaring it gets a compile error pointing here:

```text
`transport grpc` is no longer supported: protobuf/gRPC support was removed in 0.8.5
(see docs/adr/0017-remove-grpc-protobuf.md). Migrate the schema to `transport rest`
or `transport rpc` and regenerate its clients
```
</Note>

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

<Warning>
  **A JSON-only `CodecSet` will reject a default-generated TypeScript RPC client.** Since issue
  [#746](https://github.com/cratestack/cratestack/issues/746), `cratestack generate-typescript`
  defaults `transport rpc` clients to the native `@cratestack/cbor` codec, sending
  `Content-Type: application/cbor` and `Accept: application/cbor`. If your router is mounted with
  `CodecSet::new(JsonCodec)` alone — no `CborCodec` — those requests get `406`/`415` instead of a
  response. Mount `CodecSet::new(CborCodec, JsonCodec)` as shown above, or generate the client with
  `--no-native-cbor` if the server genuinely stays JSON-only. See [TypeScript client
  generation](/guides/typescript-client-generation#the-cbor-codec) for the client side of this.
</Warning>

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

On `transport rpc` the **canonical signed request is the actual rpc request** — not the REST shape. It is method `POST`, path `/rpc/<op_id>` (the concrete URL, e.g. `/rpc/model.Widget.update`, `/rpc/procedure.ping`), no query, and the raw rpc frame bytes as the body. Because the frame body carries the id / patch / args, signing it binds them — `model.Widget.get` for two different ids is two different signed requests. The server feeds exactly this into signature verification (`request_context`) and the `cratestack_route` tracing field, so it matches the rpc client byte-for-byte; the REST `/$procs/<name>` and `/<plural>[/<id>]` paths never appear on the RPC binding, for url, dispatch, signing, or logs. (On the REST binding the canonical stays the REST method / path / query / body.)

## Unary

Body shape per verb:

```jsonc
// POST /rpc/model.Widget.create
// body = CreateWidgetInput directly (same as the REST POST body shape)
{ "name": "left handle" }

// POST /rpc/model.Widget.get  or  /rpc/model.Widget.delete
{ "id": 42 }

// get (not delete) also accepts the REST fetch-query surface, all optional —
// same keys and semantics as GET /<plural>/{id}; old bare {id} frames
// keep working unchanged
{
  "id": 42,
  "fields": ["id", "name"],
  "include": ["parts"],
  "include_fields": { "parts": ["id"] },
  "computedParams": "{\"proxyUrl\":{\"width\":800}}"
}

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

List-return procedures (those declared as `... : T[]`) get `OpKind::Sequence` from the macro and negotiate over the **same** `POST /rpc/{op_id}` route as unary. Switch by content negotiation:

```http
POST /rpc/procedure.manyPings HTTP/1.1
Content-Type: application/cbor
Accept: application/cbor-seq
```

The response is a stream of codec-encoded chunks, terminated by end-of-body. With the default Accept the same op returns a single CBOR `Vec<T>` — the route doesn't change, only the wire shape.

Genuine incremental delivery is opt-in: only procedures explicitly marked with the `@stream` directive produce items as they're generated (via an `async_stream` generator internally). A plain `T[]`-returning procedure without `@stream` still negotiates `application/cbor-seq` correctly, but the response is fully buffered server-side first, then sent — it's a wire-shape change, not a latency win, unless the procedure opts in with `@stream`:

```cstack
procedure ticks(args: TickerArgs): Tick[]
  @allow(auth() != null)
  @stream
```

SSE (`text/event-stream`) is not implemented anywhere in the codebase today — it exists only as a forward-looking note in the RPC transport design doc, not as shipped behavior.

## Consuming streams

The wire side is one paragraph; the interesting question is what a client looks like on the other end of that pipe. CrateStack ships four client paths and you can pick per-app or per-request.

### The wire shape

`application/cbor-seq` is a sequence of self-delimiting CBOR top-level items concatenated back-to-back — no envelope, no length prefix, no framing bytes between items. The server emits it from `reqwest`/`axum`'s `bytes_stream()` so the body flushes as items are produced; the response is never fully buffered on the wire. The URL is the same `POST /rpc/{op_id}` that serves unary; only `Accept: application/cbor-seq` (the codec's `sequence_accept_header_value()`) flips the response shape. Op kind is decided by the schema (`OpKind::Sequence` for list-return procedures), not by the request — the model `list` verb is always `Unary` today, per the op id table [above](#op-identity).

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

The `code` field uses **gRPC-style lowercase strings**: `not_found`, `invalid_argument`, `permission_denied`, `failed_precondition`, `conflict`, `unauthenticated`, `resource_exhausted`, `unavailable`, `internal`. Never the REST binding's `SCREAMING_CASE` (`NOT_FOUND`, `FORBIDDEN`, …).

HTTP status codes match the error category. Clients that catch by status work unchanged from REST; clients that parse the body get a stable string vocabulary.

`resource_exhausted` (REST `TOO_MANY_REQUESTS`, HTTP 429) and `unavailable` (REST `UNAVAILABLE`, HTTP 503) arrived in 0.11.0 alongside the additive `CratestackError::TooManyRequests` variant ([#846](https://github.com/cratestack/cratestack/issues/846)). This matters most for `/rpc/batch`: that response is always HTTP 200 and the per-frame status is synthesized from the code, so before the arm existed a throttled frame surfaced as a synthetic 500. `@cratestack/link-batch`'s `errorStatus` now maps `resource_exhausted` to 429.

The two tower middleware layers participate in this vocabulary too: every response they emit themselves is now the codec-negotiated envelope — `RpcErrorBody` on `/rpc/*` paths, `CratestackErrorResponse` elsewhere — rather than a bare `text/plain` string. See [rate limiting](./rate-limiting#request-flow).

## Client middleware — the `RpcLink` chain

Before today, the generated TypeScript RPC client had exactly two extension points: a single `fetch` override and a single `headers` value. That's fine for one concern, but layering independent ones — logging, retry, auth-refresh — meant one consumer's override clobbering another's; there was no way to compose them.

`CratestackRpcClientOptions` now takes a `links?: RpcLink[]` array instead, modeled on [tRPC's Links](https://trpc.io/docs/client/links) and Dio's interceptor chain: each link wraps the next, terminating in the real network call. An empty or omitted `links` array is a true no-op — byte-identical to not having the option at all, so existing generated clients are unaffected until you opt in.

The types live in a new generated `src/links.ts`, re-exported from the client's `index.ts`:

```ts
export interface RpcLinkRequest {
  readonly kind: "unary" | "batch";
  readonly opId: string;
  readonly input: unknown;           // raw, pre-codec-encode
  readonly headers: Headers;
  readonly signal: AbortSignal | null;
  readonly idempotencyKey?: string;
  readonly codec: CratestackRpcCodec;
  readonly fetchFn: typeof fetch;
  readonly urls: { unary(opId: string): string; batch(): string };
}

export interface RpcLinkResponse { readonly response: Response; }

export type RpcLinkNext = (request: RpcLinkRequest) => Promise<RpcLinkResponse>;

export type RpcLink = (request: RpcLinkRequest, next: RpcLinkNext) => Promise<RpcLinkResponse>;

// Reference link, ships in every generated project:
export function createLoggerLink(logger?: Pick<Console, "info" | "error">): RpcLink;
```

Wire one or more links in at construction time:

```ts
import { ExampleWidgetClientClient } from "@example/widget-client";
import { createLoggerLink } from "@example/widget-client";

const client = new ExampleWidgetClientClient("https://api.example.com", {
  links: [createLoggerLink()],
});
```

Two composition rules to keep straight:

1. **`next` re-runs everything below it in the chain** — the real fetch *and* any links declared after it — never "just" the terminal fetch. That's what lets a retry link compose with an auth-refresh link declared earlier: calling `next` from the retry link re-invokes the auth-refresh link's own `next` chain on each attempt, not a shortcut straight to the network.
2. **`stream()` calls bypass the chain entirely.** A link that wants to inspect a response body would need to clone/replay a streamed body, which defeats the point of streaming — so `call()` and `batch()` go through `links`, `stream()` doesn't. If you need logging or auth-refresh on streaming calls today, wrap the call site itself rather than relying on a link.

This is **RPC-transport (`transport rpc`) only.** The REST binding (`transport rest`) doesn't have a link chain yet — that's a future ticket, not an oversight.

### Automatic call coalescing with `@cratestack/api`

[`@cratestack/api`](https://github.com/cratestack/cratestack/tree/main/packages/cratestack-api) is a new, hand-written (not generated) npm package, published standalone with provenance, inspired by [batshit](https://github.com/yornaath/batshit). It ships `createBatchLink()` — a batshit/tRPC-`httpBatchLink`/Apollo-`BatchHttpLink`-style automatic batch scheduler, implemented as an `RpcLink` so it composes with `createLoggerLink()` or any other link instead of being a `fetch` override that would clobber them. It transparently collapses multiple unary RPC calls issued within the same tick into one `POST /rpc/batch` request — the same batch envelope described [above](#batch-post-rpcbatch), just assembled for you instead of hand-built.

```ts
import { createBatchLink, createLoggerLink } from "@cratestack/api";
import { CratestackRpcRuntime } from "./generated/runtime";

const runtime = new CratestackRpcRuntime("https://api.example.com", {
  links: [createLoggerLink(), createBatchLink()],
});
const client = new MyGeneratedClient(runtime);

// These three calls, issued in the same tick, become ONE /rpc/batch request:
const [a, b, c] = await Promise.all([
  client.widgets.get(1), client.widgets.get(2), client.widgets.get(3),
]);
```

Semantics worth knowing before you reach for it:

| Behavior | Detail |
|---|---|
| Batching window | A microtask by default — same-tick calls collapse. Widen it across ticks with the `windowMs` option. |
| Dedup | Only collapses calls that share an explicit `idempotencyKey`. Unmarked calls are never auto-collapsed, even if textually identical — blindly merging two unmarked mutations would be unsafe, and the server does no dedup of its own. |
| Aggregate headers | Queued calls are partitioned by full transport signature (headers, fetch impl, codec, URL) before flushing — calls that share a signature share one `/rpc/batch` request; calls with different headers land in **separate** `/rpc/batch` requests instead of silently losing their headers. A `maxBatchSize` option further caps how many entries land in one partition's request before it splits. |
| Abort | Cancelling an individual call only cancels it pre-flush. Once its batch has been sent, the call rides the in-flight batch to completion. |

**This is unrelated to the server-side ORM batch primitives in [Batches](./batches)** (`batch_get`/`batch_create`/`batch_update`/`batch_delete`/`batch_upsert`). Both are called "batch" and both end up as one round trip, but they solve different problems at different layers: `createBatchLink` is client-side RPC-call coalescing — turning N small HTTP requests the *caller* issued into one `/rpc/batch` request, transparently, with no change to caller code. The ORM batch primitives are a server-side API a handler calls deliberately, taking an array of rows and processing them with per-item success/failure. Don't conflate the two — a call through `createBatchLink` still dispatches to whatever the schema's routes do per op; it doesn't imply the handler on the other end is using `batch_create` internally.

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
3. [Idempotency](./idempotency), [Batches](./batches) — closely related primitives that work the same way on either binding. Note that `Batches` covers the server-side ORM primitives, a different concept from the client-side `createBatchLink` covered above.
4. [TypeScript client generation](./typescript-client-generation) — where the generated `CratestackRpcRuntime` and its `links` option are constructed day-to-day.
