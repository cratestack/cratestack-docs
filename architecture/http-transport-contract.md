# CrateStack HTTP Transport Contract

## Status

Proposed target contract. Use this document as the canonical HTTP-wire reference before implementing negotiated multi-codec routing or client fallback behavior.

Current implementation is now partially realized:

1. generated Axum routers can negotiate `application/cbor` and `application/json`
2. list-returning procedure routes can also negotiate `application/cbor-seq` — automatically for RPC `Sequence`-kind ops, behind an explicit `@stream` attribute for REST
3. route capability metadata is generated publicly and drives handler validation and encoding
4. `application/cbor-seq` is not implemented for CRUD/model routes or request bodies
5. COSE-wrapped transport is still not implemented

## Scope

This document covers the **REST and RPC HTTP bindings** specifically — the `transport rest|rpc` generation styles, both of which speak negotiated codec/framing/envelope over plain HTTP:

1. request media type handling
2. response negotiation rules
3. current and planned media types
4. route capability expectations
5. error encoding rules

This document does not define authentication or authorization behavior.

`transport grpc` is a separate, already-shipped transport binding (protobuf over `tonic`/HTTP/2, not the JSON/CBOR-over-HTTP contract described here) and is out of scope for this document. See `./transport-architecture.md`'s "gRPC binding" section for where it is introduced.

## Transport Vocabulary

Terms in this document follow `./transport-architecture.md`.

1. codec means typed value serialization format such as JSON or CBOR
2. framing means single-value versus sequence body structure
3. envelope means an optional outer wrapper such as future COSE support

## Baseline Rules

### Requests

1. requests with bodies are selected by `Content-Type`
2. requests without bodies do not require `Content-Type`
3. unsupported request media types return `415 Unsupported Media Type`

### Responses

1. response transport is selected from the `Accept` header when present
2. if `Accept` is absent, the server chooses its default response transport for that route
3. if no acceptable response transport is available, the server returns `406 Not Acceptable`

### Errors

1. after response transport selection succeeds, both success and error bodies use the selected response transport
2. negotiation failures may return a minimal fallback error body if no response transport can be selected at all

## Media Types

### Current implemented generated-route media types

1. `application/cbor`
2. `application/json`

### Planned first-class single-value media types

1. `application/json`
2. `application/cbor`

### Planned sequence media type

1. `application/cbor-seq`

### Future envelope media types

COSE media-type details are intentionally deferred. CrateStack should not imply a COSE wire contract until the outer media type and inner-content signaling rules are documented.

## Feature Matrix

Current implemented and planned transport features:

| Feature | Status | Notes |
| --- | --- | --- |
| `application/cbor` request bodies | Implemented | Generated routes accept CBOR where the route declares request bodies. |
| `application/json` request bodies | Implemented | Generated routes accept JSON where the route declares request bodies. |
| `application/cbor` responses | Implemented | Default generated response media type today. |
| `application/json` responses | Implemented | Negotiated through `Accept`. |
| `application/cbor-seq` responses | Partially implemented | RPC `Sequence`-kind ops negotiate it directly; REST procedures need an explicit `@stream` attribute. Not available on CRUD/model routes on either binding. |
| `application/cbor-seq` request bodies | Not implemented | Explicitly deferred. |
| `application/cbor-seq` on CRUD/model routes | Not implemented | Current rollout is procedure-only, on both bindings. |
| route capability metadata | Implemented | Exposed as generated per-route constants and `ROUTE_TRANSPORTS`. |
| response decode by actual `Content-Type` in Rust client | Implemented | Includes JSON and CBOR. |
| generated Rust client sequence decode | Implemented | Buffered `Vec<T>` collection for ordinary list-returning calls. |
| streaming sequence decode API | Implemented | `RpcClient::call_streaming` and `CratestackClient::post_list_streamed` yield a bounded `tokio::sync::mpsc::Receiver` (16 in-flight items) with item-at-a-time decode as bytes arrive — no full-body buffering. See `./client-runtime.md`'s "Streaming surfaces" section for the Flutter/dio equivalents. |
| COSE envelope support | Not implemented | Reserved future seam only. |

## Request Contract

### Requests without bodies

Examples:

1. `GET /products`
2. `GET /products/{id}`
3. `DELETE /products/{id}` when the route design carries no request body

Contract:

1. `Content-Type` is ignored if no body exists unless a future host policy chooses stricter validation
2. `Accept` still controls response negotiation

### Requests with bodies

Examples:

1. `POST /products`
2. `PATCH /products/{id}`
3. `POST /$procs/publishProduct`

Contract:

1. `Content-Type` must identify one request transport supported by the route
2. the server decodes the body using the matching transport
3. unsupported media types return `415`
4. malformed bodies return `400 Bad Request` or the existing CrateStack decode error classification

Illustrative phase-one supported request media types:

1. `application/json`
2. `application/cbor`

Illustrative future sequence request media type:

1. `application/cbor-seq`

Sequence request support should remain opt-in per route rather than automatically enabled globally.

### Request body size limit

The generated `router()` / `rpc_router()` entry points apply a request body ceiling via `axum::extract::DefaultBodyLimit::max(body_limit_bytes)`, exposed as an explicit `body_limit_bytes: usize` parameter on both functions — not a fixed layer a consumer is expected to re-layer on top of (a re-layered `DefaultBodyLimit` closer to the router loses to cratestack's own, regardless of which value is larger). The default is **2 MiB**, matching `axum::body::Bytes`'s own implicit ceiling, so an unconfigured deployment sees no behavior change from before this parameter existed — a deployment that needs larger bodies passes a bigger value at construction time.

On the RPC binding specifically, `POST /rpc/batch` additionally caps the number of frames in one batch at `BATCH_MAX_ITEMS` (1000), independent of the byte-size limit above — a batch over the frame cap is rejected with an error naming the maximum, even if its total byte size is well under `body_limit_bytes`.

## Response Negotiation Contract

### Absent `Accept`

If the client omits `Accept`, the server responds with the route's default response transport.

Recommended default direction:

1. prefer CBOR for first-party internal routes unless a service explicitly chooses otherwise

### Present `Accept`

The server should evaluate the `Accept` header in priority order and choose the best supported response transport for the route.

At minimum the implementation should support:

1. exact media-type matches
2. `application/*`
3. `*/*`

If quality values are implemented, they should influence ordering. If quality values are not implemented initially, the docs and code should state that clearly rather than silently pretending full RFC behavior.

### No acceptable response transport

If none of the route's supported response transports match `Accept`, the server returns `406 Not Acceptable`.

## Route Capability Contract

Generated routes now publish transport capability metadata publicly through generated Axum constants and a registry.

Each route should be able to express:

1. allowed request media types
2. allowed response media types
3. default response media type
4. whether sequence framing is supported
5. whether an envelope is optional, forbidden, or required in a future envelope-aware design

Current generated public metadata surface:

1. per-route constants in `cratestack_schema::axum`
2. aggregated registry as `cratestack_schema::axum::ROUTE_TRANSPORTS`

Current descriptor shape:

1. `RouteTransportDescriptor { name, method, path, capabilities }`
2. `RouteTransportCapabilities { request_types, response_types, default_response_type, supports_sequence_response }`

Illustrative examples:

| Route | Allowed request types | Allowed response types | Default response |
| --- | --- | --- | --- |
| `GET /products/{id}` | none | `application/cbor`, `application/json` | `application/cbor` |
| `POST /products` | `application/cbor`, `application/json` | `application/cbor`, `application/json` | `application/cbor` |
| `GET /products` | none | `application/cbor`, `application/json`, maybe `application/cbor-seq` | `application/cbor` |

This table is descriptive guidance rather than a promise that every generated list route must expose sequence framing.

## `application/cbor-seq` Contract Direction

`application/cbor-seq` should be introduced carefully because it changes response semantics.

### Meaning

1. the HTTP body contains multiple top-level CBOR data items
2. response decoding is sequence-oriented rather than single-value oriented

### Good first uses

1. export procedures
2. event streams over finite bodies
3. large feeds where incremental processing or low-copy buffering matters

### Deferred uses

1. standard CRUD writes
2. standard detail fetches
3. blanket list-route replacement without a clear performance or UX reason

### Current implementation boundary

1. response-only support is implemented
2. explicit route opt-in is implemented through generated route capability metadata
3. explicit Rust client sequence decoding is implemented for generated list-returning procedures, including a genuinely incremental path (`RpcClient::call_streaming` / `CratestackClient::post_list_streamed`) that decodes items as bytes arrive rather than buffering the whole body first
4. request-side `application/cbor-seq` is not implemented
5. model CRUD routes do not expose `application/cbor-seq`

## Error Body Contract

### Negotiated errors

When a response transport has been selected successfully:

1. error payloads must be encoded using that same response transport
2. `Content-Type` must reflect that selected transport

### Negotiation failures

Before a response transport has been selected successfully:

1. `406` and `415` may use a minimal fallback body format
2. if the server can still choose a response transport safely, it should prefer doing so for consistency

The implementation should document any temporary fallback behavior precisely. Hidden special cases make client behavior brittle.

## Client Contract Direction

Client runtimes should align with this HTTP contract.

Required direction:

1. request transport is chosen explicitly when a request body is sent
2. `Accept` can advertise one or more acceptable response media types
3. response decoding must key off actual response `Content-Type`
4. sequence responses need explicit decode paths rather than being forced through single-value response helpers

Recommended client defaults:

1. request body codec defaults to CBOR for first-party internal callers
2. response preference order defaults to CBOR first, JSON second where both are supported
3. debugging or interoperability callers may choose JSON explicitly

## Current Repo Mapping

Current repo reality:

1. `cratestack-axum` now validates request and response headers against route transport capabilities rather than only a single router-wide codec assumption
2. `cratestack-client-rust` sends a preferred `Accept` list and decodes by actual response `Content-Type`
3. generated Rust client methods for list-returning procedures use explicit sequence-aware decode paths
4. generated Axum metadata is publicly inspectable through `cratestack_schema::axum::ROUTE_TRANSPORTS`
5. `catalog-service` wires generated routes with `CodecSet::new(CborCodec, JsonCodec)`, so its CrateStack-generated routes now support negotiated JSON and CBOR
6. `catalog-service` does not currently have a list-returning generated procedure that exercises `application/cbor-seq`
7. a router mounted with a JSON-only `CodecSet` (i.e. `CodecSet::new(JsonCodec)`, omitting `CborCodec`) now rejects a default-generated TypeScript RPC client with `406`/`415`, since `cratestack generate-typescript` defaults `transport rpc` clients to the native `@cratestack/cbor` codec (issue [#746](https://github.com/cratestack/cratestack/issues/746)) — see the warning in [RPC transport: Mounting the router](/guides/rpc-transport#mounting-the-router)


## Companion Document

`./transport-architecture.md` is the architecture source of truth for the codec, framing, and envelope split. Read that file first when deciding where a new concern belongs.
