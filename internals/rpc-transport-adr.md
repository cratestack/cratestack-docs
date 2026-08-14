---
title: "ADR 0005: RPC Binding for `transport rpc` Schemas"
description: Per-schema RPC generation style with HTTP unary, batch, and content-negotiated streaming; uniform RpcErrorBody on every error path; WS binding and subscriptions designed but pending a concrete use case.
---

# ADR 0005: RPC Binding for `transport rpc` Schemas

## Status

Accepted. HTTP surface shipped on `main` across PRs #20–#24, slated for the next minor release.

## Date

2026-05-15

## Context

The original [core architecture ADR](./core-architecture-adr) committed to "HTTP REST only" + "No RPC transport in v0" — see its "RPC binding addendum" for the supersession note. That position served the bootstrap slice well, but as the framework grew it left three real gaps that REST does not address cleanly:

1. **Batching.** Doing N writes in one round-trip without re-implementing per-route batch shapes for every model.
2. **Streaming.** A clean way to ask "give me this list as it's produced" rather than buffer-then-return.
3. **Subscriptions** (future). Long-lived push channels for `ModelEvent<X>` fan-out.

The simplest framing that doesn't compromise the REST binding is to treat REST and RPC as **two generation styles**, one per `.cstack` schema. The macro emits exactly one binding's worth of routes, descriptors, and client surface — there is no runtime flip and no schema runs both. A schema's `transport` directive picks the style up-front; everything else (auth, codecs, policy, idempotency, models, procedures, audit) is unchanged.

This ADR captures the decisions made implementing that, in the order they had to be settled.

## Decision

### Generation style is a schema-level choice

`.cstack` schemas declare their binding via a top-level directive:

```cstack
transport rpc
```

Defaults to `rest` when omitted (back-compat with everything written before the directive existed). The parser surfaces it on `Schema.transport: TransportStyle`. The macro branches on it at emission time:

- `transport rest` → existing REST router (per-model `/users`, `/users/{id}`, etc., per-procedure `/$procs/<name>`).
- `transport rpc` → `rpc_router` mounting `POST /rpc/{op_id}` + `POST /rpc/batch`.

Exactly one of `ROUTE_TRANSPORTS: &[RouteTransportDescriptor]` or `OPS: &[OpDescriptor]` is non-empty for any given schema; the other is emitted empty so downstream code can introspect uniformly. Client codegen branches on `TRANSPORT_STYLE` so generated SDKs ship one client's worth of code, not both.

**Rejected alternative.** Mount both bindings on the same schema so users get REST *and* RPC for free. Rejected because the two bindings have different semantic contracts for errors (status codes vs `RpcErrorBody`), idempotency (header vs per-frame field), and cancellation (close conn vs `Cancel` frame). Trying to keep both consistent in one runtime invites subtle "works on REST, breaks on RPC" bugs and forces every client SDK to ship dual code paths.

### Op identity in the URL, not the body

Every callable in an RPC schema gets a stable dotted id:

| Schema construct | Op id | Kind |
|---|---|---|
| `model User { ... }` | `model.User.list` | `Unary` |
| `model User { ... }` | `model.User.get` | `Unary` |
| `model User { ... }` | `model.User.create` | `Unary` |
| `model User { ... }` | `model.User.update` | `Unary` |
| `model User { ... }` | `model.User.delete` | `Unary` |
| `procedure foo(...)` | `procedure.foo` | `Unary` |
| `procedure foo(...): X[]` | `procedure.foo` | `Sequence` |
| `model User { ... } @@subscribe(...)` (future) | `model.User.subscribe` | `Subscription` |

The op id appears in the URL (`POST /rpc/model.User.list`), not the body. This is deliberate:

1. nginx, CDNs, and HTTP tracing tools work per-route without parsing payloads.
2. `curl http://.../rpc/model.User.list -d '...'` is a debuggable artifact in tickets and runbooks.
3. Per-op metrics fall out of standard HTTP middleware.

**Rejected alternative.** `POST /rpc` with `{op, input}` in the body, more uniform with batch/WS frames. Rejected for operability — losing per-route routing in nginx/CDNs is a real cost that uniformity doesn't justify.

### One handler per verb, RPC dispatcher delegates via constructed extractors

The RPC dispatcher does **not** duplicate handler logic. Each dispatch arm:

1. Decodes the RPC body into a typed input from `cratestack-axum::rpc` (`RpcPkInput<Pk>`, `RpcUpdateInput<Pk, UpdateXInput>`, `RpcListInput`).
2. Reconstructs the axum extractor the existing CRUD handler expects (`Path(id)`, `RawQuery(qs)`, `Bytes`).
3. Calls the existing `handle_*` function directly.

No handler refactor. REST and RPC share one code path per verb.

The non-obvious case is `model.<X>.update`: the patch is decoded as the concrete `Update<X>Input` (not `serde_json::Value`), then re-encoded through the same codec before being handed to the existing handler as `Bytes`. The concrete-type round-trip is required because `minicbor-serde` encodes `Option::None` as the CBOR null marker (`0xf6`) but `serde_json::Value::Null` encodes as the CBOR empty-array marker (`0x80`) — round-tripping through `Value` would silently corrupt nullable patch fields. The `list` arm similarly synthesizes a URL query string from the body via `synthesize_list_query` and hands that to the existing list handler.

**Rejected alternative.** Refactor each CRUD handler to expose a `*_rpc_inner` function taking a typed input, with the axum handler as a thin wrapper. Cleaner long-term but a meaningful refactor across three callsites per CRUD verb plus every procedure — and unnecessary for v1 given the dispatcher-side delegation works without it.

### Streaming via content negotiation, not a separate route

`Sequence`-kind ops (list-return procedures today, future `@stream` annotations) stream over the **same** `POST /rpc/{op_id}` route as unary. Clients send `Accept: application/cbor-seq` (or `text/event-stream` for SSE — when implemented); the existing axum handler does the rest via `encode_transport_sequence_result_with_status_for`. No new code path was needed in the RPC dispatcher — the existing 1:1 delegation works.

This is the cleanest part of the design. The framework already had content-negotiated sequence encoding for the REST binding; the RPC dispatcher just inherited it.

**Update, post-`@stream` directive.** At the time this ADR was written, `@stream` annotations were future work. They have since shipped: only procedures explicitly marked `@stream` get a genuinely incremental response (an `async_stream`-driven body, flushed as items are produced). A plain `Sequence`-kind op (an ordinary list-return procedure without `@stream`) still negotiates `Accept: application/cbor-seq` over this same route, but the server fully buffers the response before writing it — content negotiation alone does not imply incremental delivery. See the [RPC transport guide](../guides/rpc-transport#streaming-accept-application-cbor-seq) for the current, `@stream`-scoped behavior.

### Strict batch, no in-batch dependencies

`POST /rpc/batch` decodes a sequence of `RpcRequest { id, op, input, idem? }` frames and emits a sequence of `RpcResponseFrame { id, output?, error? }` in **request order** (so order-only clients can zip without `id` lookup). Three deliberate non-features:

1. **Not transactional.** Each frame runs in its own transaction.
2. **No in-batch dependencies.** A batch like `[create A, update B referencing A.id]` is not supported. The correct shapes are (a) two roundtrips, or (b) a single `@procedure` that owns the composite operation.
3. **Sequential processing in v1.** The design permits parallelization but v1 doesn't implement it — defer until contention is observable.

The `Idempotency-Key` HTTP header is rejected on `/rpc/batch` as ambiguous; idempotency is always per-frame via the `idem` field. A malformed batch envelope returns 400; per-frame errors don't poison the batch (200 with per-frame `error` field).

**Rejected alternative.** A `$ref` mechanism for in-batch frame dependencies. Rejected because encoding workflow into the wire protocol is how RPC frameworks rot — composite operations belong in `@procedure`.

### Uniform `RpcErrorBody` on every error path

Every error that exits the RPC binding — whether raised inside the dispatcher (decode failure, unknown op id) or inside a handler — wire-shapes as:

```json
{ "code": "not_found", "message": "widget 42", "details": null }
```

The `code` field uses **gRPC-style lowercase**: `not_found`, `invalid_argument`, `permission_denied`, `failed_precondition`, `conflict`, `unauthenticated`, `internal`, and reserved `unavailable` / `deadline_exceeded` / `canceled`. Never the REST binding's `SCREAMING_CASE`.

Implementation has two halves:

1. Dispatcher-side errors call `encode_rpc_error(&codec, &headers, &error)` directly — emits `RpcErrorBody` from the start.
2. Handler-emitted errors are post-processed in `rpc_dispatch_inner`: buffer the response body, decode `CratestackErrorResponse` (the REST shape the handler produced), translate the code via `cratestack_error_code_to_rpc_code`, re-encode as `RpcErrorBody`, same HTTP status.

A unit test forces the indirect translation table (`cratestack_error_code_to_rpc_code`) to agree with the direct mapping (`rpc_code(&CratestackError)`) variant-by-variant, so the two can't drift silently.

**Rejected alternative.** Pass an error-encoder strategy into every handler so REST and RPC bindings produce different bodies natively. Cleaner but invasive across every CRUD verb and every procedure handler — and unnecessary given the post-process hop is in-memory, only on error paths, and well-localized.

## Consequences

### Positive

1. **One handler per verb, two bindings.** REST schemas keep working unchanged; RPC schemas get the new shape without forking the handler layer.
2. **HTTP-feature-complete for v1.** Unary, batch, streaming, uniform error shape — all working end-to-end with test coverage at every layer.
3. **Client SDKs ship one binding's worth of code.** No "speak both" complexity downstream.
4. **`OpDescriptor` is a stable introspection surface.** Code generators, OpenAPI-equivalent tooling, and clients can iterate `OPS` without parsing routes.
5. **Streaming was free.** The content-negotiated sequence encoder shipped in the REST binding paid off at the RPC dispatcher with zero new code.

### Negative

1. **Two binding styles to maintain.** Bug fixes in routing, codec negotiation, or auth flow may need to land in two places — though the RPC dispatcher's delegation to existing handlers keeps that surface small.
2. **The `update` patch round-trip costs one encode + one decode per call.** Not measured in practice; assumed negligible against the DB call cost.
3. **Batch errors round-trip through `CratestackErrorResponse` before becoming `RpcErrorBody`.** Same kind of cost, only on the error path.

### Deferred

These are explicit non-features in v1. Each becomes a real ADR when a concrete use case appears.

1. **WebSocket binding + subscriptions.** Wire-side design fully captured (see ["Next cool upgrade"](../architecture/transport-architecture#next-cool-upgrade-websocket-binding-subscriptions) in the transport architecture). Pending a concrete subscription use case — see below.
2. **In-batch transactional mode.** Each batch frame is its own tx.
3. **Resumable subscriptions.** Even when subscriptions ship, the v1 will be fire-and-forget — no cursors, no replay buffer.
4. **Batch parallelization.** Server processes frames sequentially. The design permits parallelization once contention is observable.
5. **Cross-schema dispatch.** Each schema has its own op registry; mounting two schemas in one binary produces two independent registries under different prefixes.

## Subscriptions are designed but not built — why

Streaming and subscriptions look similar at the wire level (server emits a sequence of frames over time), but their **use-case profiles are very different** and CrateStack's consumer base today reflects that.

Streaming has clear demand:

1. List-return procedures naturally produce finite sequences (audit feeds, paginated reads, search results).
2. Clients can opt in by sending one HTTP header — no protocol upgrade, no long-lived connection state.
3. The encoder already existed for the REST binding.

So streaming shipped without ceremony — it was free.

Subscriptions don't have that profile yet:

1. CrateStack's audit and event-bus consumers today are **server-to-server**. They poll or consume from the audit sink directly; they don't need a WS channel.
2. External clients (mobile apps, browser SPAs) are the natural fit, but **no concrete CrateStack consumer is asking for subscriptions right now**.
3. Implementing them requires new schema syntax (`@@subscribe`), a WS frame loop in the macro-emitted dispatcher, and `CratestackEventBus` per-subscription fan-out with bounded buffers — a real ADR's worth of design effort that should be motivated by an actual user, not by symmetry with streaming.

The wire design from this ADR's §3.4 (the rejected drafts of §3.4 in the local repo `docs/design/rpc-transport.md`) stays as the target; the runtime work waits. **When a concrete subscription use case appears, that becomes ADR 0006.**

## Shipping order

| PR | Scope | Status |
|----|-------|--------|
| #20 | `transport` directive + `OpDescriptor` vocabulary | merged |
| #21 | Unary runtime for procedures + `cratestack-axum::rpc` primitives | merged |
| #22 | CRUD over RPC unary + `POST /rpc/batch` | merged |
| #23 | Uniform `RpcErrorBody` with gRPC-style codes | merged |
| #24 | Streaming test coverage for `Sequence`-kind ops (no code change) | merged |
| #182 | Composable `RpcLink` chain on the generated TypeScript client + standalone `@cratestack/api` (`createBatchLink`, `createLoggerLink`) | merged |
| — | WS binding + `@@subscribe` directive + subscription runtime | pending — see above |

## Addendum: automatic client-side batching (#182)

The "Batching" motivation in this ADR's Context section (doing N writes in one round-trip) was scoped to the **server**: `POST /rpc/batch` accepting a hand-assembled sequence of frames. It didn't say anything about who assembles that sequence — every caller had to hand-build the `RpcRequest[]` array itself.

#182 closes that loop from the client side without changing this ADR's server-side design at all. The generated TypeScript RPC client gained a composable `RpcLink` chain (`CratestackRpcClientOptions.links`, modeled on tRPC's Links / Dio's interceptor chain), and a new standalone package, `@cratestack/api`, ships `createBatchLink()` — an `RpcLink` that transparently coalesces same-tick unary calls into one `POST /rpc/batch` request. The wire shape, per-frame error isolation, and no-in-batch-dependencies rules above are all unchanged; `createBatchLink` is purely a client-side scheduler sitting in front of the same batch endpoint. See the [RPC transport guide](../guides/rpc-transport#client-middleware-the-rpclink-chain) for the full design and usage.

This is TypeScript/RPC-transport only for now — the REST binding and gRPC-Web don't have an equivalent link chain, and Rust/Dart clients don't have one either.

## Read Next

1. `../architecture/transport-architecture` for the codec / framing / envelope model that both bindings sit on top of.
2. `./core-architecture-adr` for the original v0 REST-only stance — its "RPC binding addendum" notes the supersession.
3. The local repo's `docs/design/rpc-transport.md` for the v1 design in the voice it was drafted — useful when implementing follow-ups like the WS binding, since the frame shapes and auth model are captured there in more detail than this ADR.
