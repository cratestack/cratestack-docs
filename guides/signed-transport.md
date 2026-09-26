---
title: Signed transport (COSE envelope layer)
description: Open signed requests and seal every response of a generated REST or RPC router with the `EnvelopeLayer`, per op, in front of rate limiting and idempotency.
---

# Signed transport (COSE envelope layer)

<Warning>
**Since CrateStack 0.13.1** ([cratestack#1006](https://github.com/cratestack/cratestack/issues/1006)).
The design is
[ADR 0006](/internals/cose-envelope-adr). The generated Rust client does not sign requests yet
(cratestack#1007), and the wire format (binding v1, including the AAD) may still change until
both sides have shipped (cratestack#1082).
</Warning>

`EnvelopeLayer` is a tower layer for the generated REST and RPC routers. It opens
signed requests (COSE_Sign1 or COSE_Mac0 bodies), hands the router the plain CBOR payload
they wrap, and seals the router's response against the same request. A signature then
covers the payload **and** what the request was for: the service, the method, the route and
its parameters, the query, the schema, and the `Idempotency-Key` / `If-Match` headers.

This is ADR 0006's P0 scope: unary messages and `nonce` replay protection. Streams (`chain`
mode) are P1, so a signed request never gets a stream (see [Limits](#limits)).

Use it when a TLS terminator, a proxy or a message queue sits between the client and the
service and must not be able to alter or replay a request: payments, device commands,
service-to-service calls across a trust boundary. The layer is opt-in per op, and
`Required` itself is opt-in until the schema digest stops changing on comment-only edits
(cratestack#1065, see [Limits](#limits)).

## Enable it

The server facades carry two features, both off by default:

| Feature | What it adds |
| --- | --- |
| `envelope` | `cratestack::envelope_layer` (the layer and its traits) and a generated `cratestack_schema::axum::envelope_layer(..)` per schema. No crypto crate: bring your own `ServerEnvelope`. |
| `cose` | `envelope`, plus the COSE envelope: `cratestack::cose` is a re-export of `cratestack-cose`, and `CoseEnvelope` is the default `ServerEnvelope`. |

```toml
# Until the next release, from git:
cratestack = { package = "cratestack-pg", git = "https://github.com/cratestack/cratestack", features = ["cose"] }
# or `package = "cratestack-api"` for a `db = None` service
```

Without `cose` (with or without `envelope`), no `cratestack-cose`, `p256` or `ed25519-dalek`
is in the facade's graph. The generated `envelope_layer` follows the feature of the facade a
schema is compiled through, so one crate turning `envelope` on changes nothing for another
crate's schemas in the same build.

## Wire it

Build the COSE envelope, then the layer through the schema's generated
`envelope_layer(envelope, policy, audience)`. It picks the schema's transport (REST or RPC),
its route descriptors and its `SCHEMA_SHA256_BYTES`, and returns the builder:

```rust
use std::sync::Arc;

use cratestack::cose::{CoseEnvelope, CoseMode, Ed25519Signer, StaticVerifierResolver};
use cratestack::envelope_layer::EnvelopeMode;
use cratestack::InMemoryNonceStore;

// The server's signing key, and the client keys it accepts.
let resolver = StaticVerifierResolver::new().with_key(client_verify_key);
let envelope = CoseEnvelope::server(
    CoseMode::Sign1,
    Arc::new(server_signer),          // an `Ed25519Signer`, or any `CoseSigner`
    Arc::new(resolver),               // any `CoseVerifierResolver`
    Arc::new(InMemoryNonceStore::new()),
)
.build()?;

let envelope_layer =
    cratestack_schema::axum::envelope_layer(envelope, EnvelopeMode::Required, "payments")
        .mount_prefix("/api") // the router is nested under /api
        .build()?;

let router = generated_router
    .layer(idempotency_layer)
    .layer(rate_limit_layer)
    .layer(envelope_layer); // last, so it runs first
let app = axum::Router::new().nest("/api", router);
```

- **`audience`** is this service's configured logical id, which every binding carries. It is
  not the `Host` header, must not be empty, and must differ from the audience this service
  seals its own outbound requests for.
- **The nonce store** is the replay cache. `InMemoryNonceStore` protects one process; behind
  several replicas use a shared one, such as `cratestack_cose::auth::AuthNonceStore::redis(url)`
  (the `auth` feature of a direct `cratestack-cose` dependency; see the crate README for the
  Redis requirements).
- **`.build()`** refuses an empty audience, a missing policy or transport, an empty REST
  route table, a zero body limit, an `allow_unresolved` template not starting with `/`, and
  an envelope whose media type is not `application/cose` or a type it claims.

The builder's calls commute: `.mount_prefix(..)` wins over the prefix the generated function
passes (the root), whichever order they come in. The other builder calls:

| Call | Default | Purpose |
| --- | --- | --- |
| `.mount_prefix("/api")` | `""` | Where the router is `nest`ed. Required for a nested router: without it nothing resolves, and every request fails closed (or, under a non-`Required` `unresolved_mode`, passes unsigned; see [Fail closed](#fail-closed)). |
| `.allow_unresolved(["/health"])` | none | Hand-written routes merged into the generated router before the layer. |
| `.unresolved_mode(mode)` | the policy's | Explicit opt-out of fail-closed for unbindable routes. |
| `.principal_mapper(..)` | `ThumbprintPrincipal` | What the signer is charged to. |
| `.response_seal_policy(..)` | `AcceptNamesEnvelope` | Under `Optional`, which unsigned responses are sealed. |
| `.max_body_bytes(n)` | `DEFAULT_MAX_BODY_BYTES` | The request body the layer buffers (`413` beyond). |

Without the generated function, `EnvelopeLayer::builder(envelope, audience,
cratestack_schema::SCHEMA_SHA256_BYTES)` takes `.policy(..)` and one of `.rest(prefix,
cratestack_schema::axum::ROUTE_TRANSPORTS)`, `.rpc(prefix)` or `.binding_resolver(..)`;
neither the policy nor the transport has a default.

### Placement

The layer must be the **last** `.layer(..)` on the generated router, applied **before** the
router is `nest`ed or `merge`d:

- **Last, so it runs first.** The rate limiter and the idempotency layer key on the
  `VerifiedPrincipal` it inserts (`cose:<hex thumbprint>` by default), so a signed client needs
  neither `Authorization` nor `ConnectInfo`. The idempotency layer hashes the opened payload,
  so a client that re-seals a retry (a new `cti` under the same `Idempotency-Key`) gets the
  stored response, sealed afresh for the new request.
- **Through `Router::layer`**, so `MatchedPath` and the path parameters are in the request.
  A `ServiceBuilder` around the whole app loses them, and `nest_service` never sets
  `MatchedPath` for the outer mount.
- **An IP-level limiter outside it.** Verification, with its key-resolver and nonce-store
  lookups, runs **before** rate limiting, and under `Optional` so does signing every response
  to a signed or nonce-bound request. Bound what an unauthenticated flood can cost with a
  limiter in front of the envelope.

The generated routers' default body limit applies to the payload after opening. The layer's
own cap, `DEFAULT_MAX_BODY_BYTES`, is that limit plus 16 KiB of envelope overhead; raise it
with `.max_body_bytes(..)` if the router gets a larger limit.

## Modes

An `EnvelopePolicy` picks a mode per op. `EnvelopeMode` is itself a policy (one mode for every
op), and so is any `Fn(&PolicyRequest<'_>) -> EnvelopeMode`. There is no default.

| Mode | Unsigned request | Signed request |
| --- | --- | --- |
| `Required` | Refused, unsigned `401`. | Opened; response always sealed. |
| `Optional` | Runs. Response sealed only with a valid `Cratestack-Nonce` **and** (the default `ResponseSealPolicy`) an `Accept` naming `application/cose`; otherwise plain. | Opened; response always sealed. |
| `Off` | Untouched. | Refused, unsigned `415`. |

- **Everything is signed under `Required`**, `GET`, `HEAD` and `DELETE` included: a bodiless
  request seals an empty payload and reaches the router bodiless. A signed `HEAD` still sends
  its COSE message as a request body, to which RFC 9110 gives no semantics: hyper and `reqwest`
  pass it over HTTP/1.1, but an intermediary may drop it (the request then fails, `401`) or
  refuse the request. Prefer `GET` under `Required`.
- **A signed request is always answered sealed**, under `Optional` as under `Required`, with
  its `Accept` forced to `application/cbor`. A verification failure is the `401`, never a
  downgrade to unsigned.
- **An unsigned seal under `Optional` binds the nonce and the payload, not the caller.** It
  proves this server answered this nonce and body, not who asked; do not read it as an
  authenticated exchange.
- **In every mode, a body whose `Content-Type` is `application/cose`** (any case, any
  parameters) is opened and verified, or refused with the `415`. It is never forwarded.
- **A bodiless `OPTIONS`** (a CORS preflight) passes untouched on both transports.

### Per-op policy

A policy sees a `PolicyRequest`: the method, the op (a REST route template such as
`/widgets/{id}`, or an RPC op id such as `procedure.ping`), and two flags. It sees no header,
so no request can talk it into a weaker mode.

```rust
use cratestack::envelope_layer::{EnvelopeMode, PolicyRequest};

let policy = |request: &PolicyRequest<'_>| {
    if request.is_subscription() { EnvelopeMode::Optional } else { EnvelopeMode::Required }
};
```

Annotate the closure's parameter type as above: the builder takes `impl EnvelopePolicy`,
not an `Fn` bound, so the compiler has nothing to infer it from. The same holds for
closure principal mappers and seal policies.

- An RPC subscription is shown with its **bare** op id (`model.Widget.subscribe`) and
  `is_subscription()` set.
- **`/rpc/batch`** runs under the **strictest** mode of `batch` itself and of every frame's
  op (`is_batch_frame()` set, method `POST`), so a batch cannot carry an op its policy would
  refuse unsigned. The frames are read by the body's base `Content-Type` (parameters and case
  ignored).
- `EnvelopePolicy::unresolved_mode()` decides traffic the layer cannot attribute to one op (next
  section). It defaults to `Required`; an `EnvelopeMode` used as the policy answers itself.

## Fail closed

Under a `Required` `unresolved_mode`, a route the router **matched** but the layer cannot bind
is refused with an unsigned `500` instead of passing unsigned. That is what a wrong or
missing mount prefix, `nest_service`, or route-descriptor drift looks like. The response body
is a generic internal error; the server log says `envelope misconfigured` (target
`cratestack`, throttled to once a minute) and names the matched route and the configured
prefix.

- **Hand-written routes** on the same router (`/health`, a `.well-known` path) are listed with
  `.allow_unresolved(["/health"])`, relative to the mount prefix. Plain traffic to them passes;
  a COSE body is still the `415`.
- **Another method on a generated path** is the layer's own `405` with an `Allow` header
  (body code `METHOD_NOT_ALLOWED` on REST, `invalid_argument` on RPC), so a hand-written handler
  for that method cannot run unsigned.
- **An unmatched path** (a `404`) passes through, as does a `Router::fallback` handler, which
  sets no `MatchedPath` and is therefore **not protected**.
- **A closure policy fails closed** by default. `.unresolved_mode(EnvelopeMode::Optional)` (or
  `Off`) is the explicit opt-out: unbindable routes then pass plain, with a warning logged once
  per process, and so does every route when the prefix is wrong. Prefer `allow_unresolved`.
- **A plain batch whose frames the layer cannot read** is refused unless the strictest of
  `batch` and `unresolved_mode` is `Off`: the unsigned `401` under `Required`, an unsigned `400`
  otherwise. A signed batch is opened unless both are `Off` (then the `415`); once opened,
  unreadable frames are a **sealed** `400`, and a batch whose every answer is `Off` is the
  unsigned `415`.
- **`/rpc/{op_id}`** never binds an op id that is `batch`, contains `/` or has no `.`, checked
  on the decoded value (so `/rpc/%62atch` is caught): a COSE body there is the `415`.

## What is bound

The external AAD, which both sides rebuild and nobody sends, binds:

- the audience, the method, and the route: the REST route template the schema declares, or the
  RPC op id (`batch` for `/rpc/batch`, `subscribe/<op id>` for a subscription);
- every matched path parameter, a parameterised mount's (`nest("/t/{tenant}", ..)`) included,
  so a request signed for tenant `a` cannot be replayed at tenant `b`;
- the query in `canonical_query` form: distinct keys bind alike in any order, but one key's
  repeated values keep their order (`?tag=a&tag=b` is not `?tag=b&tag=a`). An RPC call binds its
  query too; generated RPC clients send none, and a client that adds one (a cache-buster) must
  bind it;
- the schema digest (`SCHEMA_SHA256_BYTES`) and the payload media type (`application/cbor`);
- **`bound_headers`**: `Idempotency-Key` and `If-Match` **exactly as sent** (UTF-8, untrimmed),
  or null. A proxy that strips the key from a re-sealed retry (so it would run twice) or
  alters `If-Match` breaks the signature. A request sending either header twice, or a value that
  is not UTF-8, is refused with an unsigned `400`;
- for a response: the request digest (SHA-256 of the request's exact COSE bytes, or for an
  unsigned `Optional` request, of its nonce and payload) and the status.

**Response headers are not authenticated**: `ETag`, `Retry-After`, `Location` and the rest can be
altered in transit. Don't base a security decision on one.

## What the router sees

An opened request reaches the router as the plain request it wraps: the payload as
`application/cbor` (no `Content-Type` for an empty payload) with `Accept: application/cbor`.

- The `AuthProvider` authenticates **that payload**. A client that also sends
  `Authorization: Signature` signs the payload, not the COSE bytes.
- The layer inserts `cratestack_core::VerifiedSigner` (visible to the `AuthProvider` in
  `RequestContext::extensions`), and generated handlers record it on the context
  (`ctx.verified_signer()`). It is a **fact, not an authentication**: identity stays the
  `AuthProvider`'s decision. A signer-to-identity adapter is cratestack#1077.
- The layer inserts `VerifiedPrincipal`, which the rate limiter and the idempotency layer key
  on (`princ:<sha256>`); see [Idempotency](./idempotency#principal-scoping) and
  [Rate limiting](./rate-limiting#key-function).

## Errors

The layer's **own refusals go out unsigned**: they are decided before (or instead of) a
verified request, and a replayed request must not earn a signed answer. **Everything else a
signed request gets back is sealed**, errors included.

| Response | Signed? | When |
| --- | --- | --- |
| `401` | unsigned | Unsigned under `Required`; any verification failure (bad signature, wrong binding, replay, unknown key); the principal mapper returned `Unauthorized`. Always the same coarse answer. |
| `415` | unsigned | A COSE body under `Off`, or anywhere the layer binds no op (an unmatched path, an allow-listed or unbindable route, a malformed `/rpc/{op_id}`); a signed batch whose every answer is `Off`. |
| `400` | unsigned | A bound header sent twice or not UTF-8; a body that failed to arrive; an unreadable plain batch (not under `Required`). |
| `413` | unsigned | The body exceeds the layer's `max_body_bytes`. |
| `405` | unsigned | Another method on a generated path, under a `Required` `unresolved_mode`. |
| `500` | unsigned | `envelope misconfigured`; a key-resolver, nonce-store or signer outage; an envelope that labels its seal as a non-envelope type. The detail is only logged. |
| handler errors, `409`, `412`, `422`, `429` | **sealed** | Anything the router answers for a bound op: a handler's `404` or `403`, the rate limiter's `429`, the idempotency layer's `409`/`412`/`422`, the RPC router's `404` for a well-formed unknown op id. A non-CBOR error (axum's own `413`, a `text/plain` fallback) is re-encoded as the transport's CBOR error first. A plain request to an unmatched path gets the router's plain `404`. |
| `406` | **sealed** | A signed request to an RPC subscription (before its handler runs), or any other response a signed request would get as a stream. |
| `400` | **sealed** | A signed `/rpc/batch` whose frames cannot be read once opened. |
| `500` | **sealed** | A non-CBOR success to a signed request; a response over `MAX_RESPONSE_REBUFFER_BYTES`; the principal mapper failed (other than `Unauthorized`) or returned `""`. |

## Extension points

Each mechanism is a trait with the decided default installed by the builder:

| Trait | Default | Replace it to |
| --- | --- | --- |
| `ServerEnvelope` | `CoseEnvelope` (feature `cose`) | put another verifier/signer behind the layer (a KMS/HSM one, the Sign1 + Mac0 composite of cratestack#1078). For COSE keys in a KMS, a custom `CoseSigner` / `CoseVerifierResolver` on `CoseEnvelope` is usually less work. |
| `EnvelopePolicy` | none (required) | pick a mode per op. |
| `BindingResolver` | `RestBindingResolver` / `RpcBindingResolver` | bind a router mounted in a way they cannot see through; returns a `Resolution` (`Op`, `NotAnOp`, `MethodNotAllowed`, `Unresolved`). |
| `PrincipalMapper` | `ThumbprintPrincipal` (`cose:<hex thumbprint>`) | charge a signer to something coarser (its owner, its tenant). Async and fallible. |
| `ResponseSealPolicy` | `AcceptNamesEnvelope` | decide, under `Optional`, which nonce-bound unsigned responses are sealed. |

`ServerEnvelope::open_request` returns an `OpenedRequest` carrying an opaque per-request
`SealContext`, which the layer hands back, untouched, to the same request's `seal_response`;
that returns `Sealed { body, media_type }`, so a composite can answer Mac0 with Mac0.
`ServerEnvelope` is also implemented for `Arc<T>`, and `envelope_layer::async_trait` is
re-exported for implementing it.

**Wrapping `CoseEnvelope`?** Delegate through the trait's full path.
`CoseEnvelope` also has inherent, typed `open_request` / `seal_response` methods, and
method-call syntax picks those, so `self.inner.open_request(body, bind)` does not type-check:

```rust
use bytes::Bytes;
use cratestack::envelope_layer::{OpenedRequest, SealContext, Sealed, ServerEnvelope, async_trait};
use cratestack::{Binding, CratestackError};
use cratestack::cose::CoseEnvelope;

struct Audited { inner: CoseEnvelope }

#[async_trait]
impl ServerEnvelope for Audited {
    fn media_type(&self) -> &'static str {
        ServerEnvelope::media_type(&self.inner)
    }

    async fn open_request(&self, body: Bytes, bind: &Binding<'_>) -> Result<OpenedRequest, CratestackError> {
        ServerEnvelope::open_request(&self.inner, body, bind).await
    }

    async fn seal_response(
        &self,
        payload: &[u8],
        bind: &Binding<'_>,
        context: &SealContext,
    ) -> Result<Sealed, CratestackError> {
        ServerEnvelope::seal_response(&self.inner, payload, bind, context).await
    }
}
```

A synchronous principal mapper is a closure, and the default's prefix is configurable:

```rust
use cratestack::envelope_layer::{ThumbprintPrincipal, VerifiedRequest};

let builder = builder.principal_mapper(ThumbprintPrincipal::with_prefix("device:"));
// or
let builder = builder.principal_mapper(|v: &VerifiedRequest<'_>| {
    Ok(format!("owner:{}", lookup_owner(v.signer().thumbprint())))
});
```

A mapper's `Err(CratestackError::Unauthorized(_))` (a revoked device) is the unsigned `401`;
any other error is a sealed `500`. Pick a prefix no other source of `VerifiedPrincipal` in the
application uses: the rate limiter and the idempotency layer see only the string.

### What the layer enforces whatever a plug-in does

- A request with an `application/cose` body (or one the envelope claims) is opened and verified
  before anything else sees it, or refused with the `415`, whatever the policy says.
- Under `Required`, no unsigned request reaches the router and no response to a signed request
  goes out plain; one the layer cannot seal is replaced by a sealed error.
- Every verification failure is the same coarse, unsigned `401`; any other envelope error is a
  `500` whose detail is only logged.
- The `PrincipalMapper` only ever sees a `VerifiedRequest`, which has no public constructor. An
  empty principal is refused (a sealed `500`).
- The resolver and the policy are consulted once per request, and the response binding reuses
  the values the request was opened against, so no plug-in can make the two disagree.
- A `Sealed` whose media type is not `application/cose` or one the envelope claims is never
  sent.

## Limits

- **Streams cannot be sealed** until ADR 0006 P1 (`chain` mode). A signed request gets
  `Accept: application/cbor`, so a `@stream` op answers with one buffered, sealed array; a
  signed subscription is a sealed `406` before its handler runs. Only an unsigned request under
  `Optional` streams (plain), so give subscriptions `Optional` or `Off` in the policy.
- **Responses are re-buffered** to be sealed, up to `MAX_RESPONSE_REBUFFER_BYTES` (8 MiB);
  a longer one becomes a sealed `500`. The payload is copied once into the sealed message; the
  zero-copy API is cratestack#1076.
- **The schema digest hashes the raw `.cstack` text**, so a comment-only edit changes it and
  breaks every signed client (cratestack#1065). `Required` is opt-in until that is settled.
- **One envelope per layer.** A router accepting Sign1 devices and Mac0 services at once needs
  the composite of cratestack#1078.
- **The generated Rust client does not sign yet** (cratestack#1007), and binding v1 is not
  frozen (cratestack#1082).
- **A signer is recorded, not authenticated**: mapping it to an identity is cratestack#1077.

## Read next

1. [ADR 0006](/internals/cose-envelope-adr) for the envelope, the AAD layout and the threat model
2. [Idempotency](./idempotency) and [Rate limiting](./rate-limiting), which key on the principal the layer inserts
3. [Auth provider](./auth-provider) for identity, which the envelope does not decide
