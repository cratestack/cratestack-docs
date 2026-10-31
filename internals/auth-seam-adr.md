---
title: "ADR 0021: Pluggable Authentication: the AuthProvider Seam"
description: One public seam that CrateStack's own authentication and any external library plug into equally. It covers the refusal envelope on every transport, a principal contract with reserved claim names, the canonical request a signing provider verifies, a provider-decided credential check for MCP, a first-success provider chain, a conformance kit, and a CI guard that keeps auth libraries out of the framework. Proposed.
---

# ADR 0021: Pluggable Authentication: the AuthProvider Seam

## Status

**Proposed**, 2026-10-28. It is the first child story of epic
[cratestack#1243](https://github.com/cratestack/cratestack/issues/1243). Acceptance is still the
maintainer's decision, but what the sections below record as built shipped in CrateStack 0.17.1
(2026-10-31): the refusal envelope on REST, RPC, SSE, middleware errors, MCP and sync (§1,
[cratestack#1208](https://github.com/cratestack/cratestack/issues/1208), in
[cratestack#1246](https://github.com/cratestack/cratestack/pull/1246)), the principal contract (§2),
the canonical-request rule (§3), MCP's pluggable credential presence and the defaulted
`AuthProvider::credential` (§4), the first-success chain (§5), the conformance kit (§6) and the
independence guard (§7). The guides document that surface as supported.

The number is the next free one across both repositories. 0007–0010 are reserved by ADR 0001,
0011–0019 are the framework's internal-shape series, and 0020 is the sync engine. The "ADR 0032" and
"ADR 0038" that appear in framework comments belong to an external (Webank) series, not this one. This
ADR lives here rather than in the framework because the refusal envelope, the claim names and the
canonical request are all visible to clients and to authors of auth libraries.

## Date

- 2026-10-28: proposed. The refusal envelope (§1) is built for REST, RPC unary and RPC batch.
- 2026-10-29: updated for cratestack#1246, which also renders refusals on MCP Streamable HTTP and sync,
  fixes sync's leak of `Internal` detail, and builds MCP credential presence as a builder option
  (`CredentialPresence`) rather than the trait method first proposed in §4.
- 2026-10-30: stories 6 and 7 built: the canonical-request rule is stated on `RequestContext` and
  pinned by tests (sync now passes its declared route), and the first-success chain, the defaulted
  `AuthProvider::credential` (default `Unknown`, §4) and `CredentialPresence::ask_provider()` exist.
- 2026-10-30: stories 8–10: the conformance kit (§6) and the independence guard (§7) are built, and
  `CoseAuthProvider` is a first-success chain (§5). `CoseAuthProvider` and
  `SignedRequestAuthProvider` pass the kit.
- 2026-10-31: cratestack#1245 builds the external-library example of §7, `examples/auth-pluggable`:
  one schema and one suite (the kit plus the example's own policies) against three providers,
  in-house, Authkestra device signatures, and Authkestra OIDC with DPoP. Its CI job `auth-pluggable`
  runs `.ci/auth-pluggable-check.sh`, the example-side assertions below.
- 2026-10-31: everything built above released in CrateStack 0.17.1, with the WebTransport binding
  (cratestack#1238) that renders a refusal as an `{id: 0, err}` frame before it closes.

## The standing decision this ADR serves

The maintainer decided on 2026-10-28 that **CrateStack does not depend on or delegate to Authkestra**,
or to any other authentication library. Instead, the seam must be complete enough that CrateStack's own
authentication (`cratestack-auth`, `cratestack-cose`'s `auth` feature) and an external library (for
example Authkestra's `authkestra-devsig` or `authkestra-resource`) plug in **equally**, through the
public `AuthProvider` trait and nothing else. Only examples and applications depend on an external
auth library.

Every decision below follows from that. A capability the in-house providers need is either public, or
it is a bug in this seam.

## Decisions for the maintainer

| # | Question | Recommendation | Decision |
|---|---|---|---|
| D1 | How does a provider shape its refusal, and how does each transport render it? | **`AuthRefusal`, as built in #1208**: 401 or 403, extra top-level envelope members that never replace `code`/`message`/`details`, an optional `details`, and `WWW-Authenticate` challenges. The `code` stays framework-owned. Every transport that calls `AuthProvider` renders it (the matrix in §1). | built in #1246 for REST, RPC unary and batch, SSE, middleware errors, MCP and sync, and in #1238 for WebTransport (`{id: 0, err}` before the close); open for WebSocket, which is design only (Q5). In 0.17.1 |
| D2 | What does a provider map the caller *to*? | **A principal contract**: a small set of reserved claim names with fixed types (`sub`, `roles`, `tenant.id`, `auth_time`, `amr`, `acr`, `cnf`, `key_role`, `exp`), a builder in `cratestack-core`, and typed readers that `hasRole`, `inTenant` and the framework's own code use. Everything else stays free-form. | built in #1250 (story 5). In 0.17.1 |
| D3 | What request does a provider verify? | **The canonical request**: the route CrateStack declares, never the mount prefix, with the exact body bytes the router received. One rule, stated per transport, tested by the kit. | built in #1248 (story 6). In 0.17.1 |
| D4 | How does MCP know a request carries a credential? | **The deployment chooses, on the MCP builder**: `CredentialPresence::bearer()` (the default, today's RFC 6750 check), `provider_decides()` or `when(predicate)`, plus `with_credential_headers` for the headers to strip and redact. MCP stays Bearer-only unless the deployment opts in, to keep ADR 0002's OAuth resource-server posture. A defaulted `AuthProvider::credential` method remains proposed for D5's chain (§4) | built in #1246 (builder) and #1248 (the defaulted trait method, default `Unknown`, and `ask_provider()`). In 0.17.1 |
| D5 | How are providers composed? | **A first-success chain in core**: a provider with no credential is skipped, the first authenticated answer wins, and a refusal stops the chain. | built in #1248 (story 7). In 0.17.1 |
| D6 | How does a provider prove it behaves the same everywhere? | **A conformance kit behind a `testing` feature** that drives one provider through every transport and asserts identical verdicts, canonical requests and refusal rendering. | built in #1251 (story 8), as the crate `cratestack-auth-conformance`. In 0.17.1 |
| D7 | How is independence enforced? | **No framework crate depends on any auth library**, checked in CI with `cargo tree` and `cargo metadata`. The external-library example lives outside the workspace with its own lockfile, like `examples/client-only-verification`. | built in #1251 (story 10) and #1254 (`examples/auth-pluggable`). In 0.17.1 |

## Context

### Facts at `d3c476a` (0.17.0) and `d8b088e` (the #1208 branch)

1. **The trait.** `AuthProvider` has one method,
   `authenticate(&RequestContext) -> Result<CratestackContext, Self::Error>`, with
   `type Error: Into<CratestackError>`
   ([`context.rs`](https://github.com/cratestack/cratestack/blob/d3c476a5acb4681ee82fc39d42fe532d3c3064cb/crates/cratestack-core/src/context.rs)).
   A header-only closure implements it through a blanket impl.
2. **The request.** `RequestContext` carries `method`, `path`, `query`, `headers`, the **full
   buffered `body`** and the in-process `extensions` (trusted, unlike headers). Body-hash schemes
   (`bdh`-style device signatures, SigV4-style content hashes) can therefore verify today.
3. **The context.** `CratestackContext` holds an `auth` identity (a flat field map) and a
   `principal` (`actor`, `session` and `tenant` facets plus a claims map). Both are untyped.
   `auth_field(path)` resolves dotted paths across both. Two private, non-serializable facts sit next
   to them: the system flag (`SystemContext`) and the `VerifiedSigner` an envelope recorded
   (ADR 0006 §12). Neither can be set by a provider.
4. **Policies read conventions, not a contract.** `hasRole(r)` reads `role`, then `actor.role`, and
   compares one string. `inTenant(t)` reads `tenant.id` as a string
   ([`eval.rs`](https://github.com/cratestack/cratestack/blob/d3c476a5acb4681ee82fc39d42fe532d3c3064cb/crates/cratestack-policy/src/eval.rs)).
   `auth().<path>` is resolved at compile time against the schema's `auth` block and read with
   `auth_field` at run time. Framework code reads the caller's id in at least three ways:
   `principal_actor_id()` (`actor.id`, then `claims.id`, then `auth.id`, strings only), MCP's
   admission key (`principal_id`, which also renders an integer `id` as its digits, so that
   `auth User { id Int }` schemas work), and the WebTransport session key in #1238 (`actor.id`, then
   `id`, then `sub`). COSE's signer principal writes `id = "cose:<thumbprint>"`. `cratestack-sync` asks
   an application-supplied resolver.
5. **The only shipped mapper is product-specific.** `cratestack-auth`'s
   `principal_to_cratestack_context` emits `actor { id, enrollmentStatus, kycStatus, … }`,
   `session { clientId, boundKeyId, requestNonce, … }`, `id`, `clientId`, `role`, `kycStatus`,
   `kycDossierId`. An external library has nothing documented to map to.
6. **Refusals.** Before #1208, `into_response()` always set `details: None` and a provider could only
   choose between `UNAUTHORIZED` and `FORBIDDEN` with a message. Clients that sort refusals by reason
   (fespalier's device-signature classifier: `attestation_expired` means renew, `key_not_bound` means
   signed out, `DEVICE_REVOKED` means revoked; OAuth's `invalid_token` and `insufficient_scope`) could
   not work through the generated router. fespalier's `examples/cratestack` refuses in a tower layer in
   front of the router instead.
7. **Each transport calls the provider its own way.** REST and RPC unary authenticate per request.
   RPC batch authenticates the envelope once and hands every frame a `CachedAuthProvider`. SSE model
   subscriptions authenticate `GET /rpc/subscribe/<op_id>` once, before the stream. MCP Streamable HTTP
   requires `Authorization: Bearer` before the provider runs
   ([`streamable_http/auth.rs`](https://github.com/cratestack/cratestack/blob/d3c476a5acb4681ee82fc39d42fe532d3c3064cb/crates/cratestack-mcp/src/streamable_http/auth.rs)).
   `cratestack-sync` turns any provider error into `401 unauthenticated`
   ([`server/http/mod.rs`](https://github.com/cratestack/cratestack/blob/d3c476a5acb4681ee82fc39d42fe532d3c3064cb/crates/cratestack-sync/src/server/http/mod.rs)).
   The WebTransport binding in [cratestack#1238](https://github.com/cratestack/cratestack/pull/1238)
   (open) authenticates once per session.
8. **Composition is hand-written.** `CoseAuthProvider` wraps an inner provider: the inner one runs
   first, its authenticated answer or its error is returned as is, and only an anonymous answer falls
   back to the verified signer
   ([`signer_provider.rs`](https://github.com/cratestack/cratestack/blob/d3c476a5acb4681ee82fc39d42fe532d3c3064cb/crates/cratestack-cose/src/auth/signer_provider.rs)).

### Goals and non-goals

Goals: one seam, identical behaviour on every transport, nothing private for in-house providers, and a
test kit an external provider can run.

Not goals, as in the epic:

- a built-in OAuth or OIDC server, or a user store;
- schema grammar for freshness or step-up. That is
  [cratestack#1244](https://github.com/cratestack/cratestack/issues/1244), which builds on §1 and §2;
- any change to the COSE envelope wire format (ADR 0006);
- any dependency of a framework crate on an auth library.

## Decision

### 1. The refusal envelope (D1)

#### As built in #1208

A provider refuses with `Err(AuthRefusal::unauthenticated(msg).with_member(..).into_error())`:

| Builder | Effect |
|---|---|
| `AuthRefusal::unauthenticated(message)` | 401; REST code `UNAUTHORIZED`, RPC code `unauthenticated` |
| `AuthRefusal::forbidden(message)` | 403; REST code `FORBIDDEN`, RPC code `permission_denied` |
| `.with_member(name, value)` | an extra top-level envelope member after `code`, `message` and `details`. The names in `RESERVED_ENVELOPE_MEMBERS` (`code`, `message`, `details`) are ignored |
| `.with_details(value)` | the envelope's `details` |
| `.with_challenge(value)` | one `WWW-Authenticate` header value. A value with anything but visible ASCII, space and tab is ignored, so a refusal can never break the response it rides on |

The source is
[`error/auth_refusal.rs`](https://github.com/cratestack/cratestack/blob/d8b088e2fa2f9c3975e87fbf07f701d16c8540ce/crates/cratestack-core/src/error/auth_refusal.rs).
Five properties of the built design are decisions this ADR records.

- **The refusal becomes `CratestackError::AuthRefused` through `into_error()`, and there is
  deliberately no `From<AuthRefusal> for CratestackError`.** A second `From` impl on
  `CratestackError` makes every `?` whose error type was inferred through the reflexive
  `From<T> for T` ambiguous (E0283), in generated code and in application code alike. The trait's
  `type Error: Into<CratestackError>` is unchanged, so no existing provider breaks.
- **The `code` stays framework-owned.** The epic's first sketch let a provider choose the wire `code`.
  The built design does not: a client that switches on `UNAUTHORIZED` or `unauthenticated` keeps
  working, and a provider's own reason travels as a member. By convention that member is named
  `error`, the name RFC 6750 uses and fespalier's classifier reads
  (`{"code": "UNAUTHORIZED", "message": "attestation expired", "error": "attestation_expired"}`). The
  convention is documented, not enforced.
- **Only 401 and 403.** A refusal is about who the caller is. A provider that cannot decide (a JWKS
  endpoint is down) returns `Unavailable` or `Internal`, which keep their canned public messages. A
  refusal is never a 5xx.
- **No byte changes for anyone else.** `CratestackErrorResponse` and `RpcErrorBody` gain a public
  `extra` map, serialized by hand as a known-length map, never `#[serde(flatten)]` (which a CBOR
  encoder writes as an indefinite-length map). An envelope without extra members encodes byte for
  byte as before, in JSON and in CBOR (`cratestack-codec-cbor/tests/error_envelope_bytes.rs`).
  Unknown members of an envelope read from the wire are collected into `extra`.
- **Challenges ride on the error, not in the envelope.** Every encoder takes them off the error before
  it is consumed and appends them to the response
  ([`auth_challenge.rs`](https://github.com/cratestack/cratestack/blob/d8b088e2fa2f9c3975e87fbf07f701d16c8540ce/crates/cratestack-axum/src/auth_challenge.rs)).
  The RPC binding re-encodes a handler's REST-shaped error into an RPC body and copies the header
  across. The streaming (`@stream`) and middleware error paths attach them too.

Tests: `crates/cratestack-api/tests/auth_refusal_rest.rs` and `auth_refusal_rpc.rs` (a member and a
challenge on 401, `details` on 403, reserved names not replaceable, a plain `Unauthorized` unchanged,
and the batch case).

#### The transport matrix

"Today" is `d8b088e`, with #1238's branch for WebTransport. "Target" is what this ADR decides.

| Transport | Today | Target |
|---|---|---|
| REST (models and procedures) | #1208: status, members, `details` and challenges | As built. The kit asserts it |
| RPC unary, `POST /rpc/<op_id>` | #1208: same status, members, `details` and challenges, RPC codes | As built |
| RPC batch, `POST /rpc/batch` | #1208: the envelope is authenticated once, so a refusal answers **the whole batch** with the unary error body, its status and its challenges. No frame runs | As built. A refusal is never repeated per frame: there is one verdict for one envelope, and a `200` holding N copies of it would hide the status and the challenges. Policy denials stay per frame, as today |
| SSE model subscription, `GET /rpc/subscribe/<op_id>` | Refused before the stream starts, through the RPC error path, so #1208 applies. Untested. After `Ready`, the context captured at open is used for every event | Kit case for the pre-stream refusal. Credential expiry on a live stream belongs to the subscriptions design (S1/S5), which reads `exp` (§2) |
| `@stream` procedures (SSE, CBOR sequence) | Refused before the first item; #1208's challenges are attached | As built, with a kit case |
| MCP Streamable HTTP | Before #1246: no Bearer token gave a `401` with the resource-metadata challenge before the provider ran, and a provider refusal was replaced by a canned `invalid_token` (401) or `insufficient_scope` (403), dropping members, `details` and challenges. **Built in #1246:** an `AuthRefusal` keeps its status, message, members and `details` in MCP's envelope, and its challenges follow MCP's own Bearer challenge (with `resource_metadata`, as ADR 0002 requires). Credential presence is the deployment's choice (§4). An anonymous answer stays a 401. Tests: `crates/cratestack-mcp/tests/http_refusal.rs`, `http_credential.rs` | As built |
| MCP stdio | No provider: the application passes the context (ADR 0002 Q1, F2) | Unchanged |
| `cratestack-sync` (`/sync/*`) | Before #1246: any provider error became `401` `unauthenticated` with `error.to_string()` as the message, so a 403 and an undecided provider's 5xx became 401s, members and challenges were lost, and an `Internal` error's private detail reached the client. **Built in #1246:** 401 stays `unauthenticated`, 403 becomes a new `forbidden` sync code, a 5xx becomes `internal`; the message is `public_message()`; members go into the sync error body under the same reserved-name rule (`RESERVED_SYNC_ERROR_MEMBERS`), challenges into the headers. Test: `crates/cratestack-sync/tests/auth_refusal.rs`, including `a_provider_failure_is_internal_and_leaks_nothing`. A provider `Unavailable` (503) reads as sync `internal` (500): sync has no 503 code | As built. Sync is exempt from REST/RPC parity (ADR 0020 D7), but not from this ADR, because it calls `AuthProvider` |
| WebTransport session (#1238) | Authentication runs on the control stream's first frame (`Init`, for browsers) or on the CONNECT headers (native clients). A refusal closes the session with `4401` and a fixed reason; `4403` means a re-authentication named another principal, `4429` too many sessions, `4400` a protocol error. There is no envelope, so members, `details` and challenges are lost. CONNECT-level refusals (403 Origin, 404 path, 406 codec) are HTTP statuses and do not involve authentication | Built in #1238 (0.17.1): before closing, the server writes `{id: 0, err: RpcErrorBody}` on the control stream, with the refusal's members and `details`, then closes with `4401` for a 401, `4403` for a 403 or a changed principal, `4400` for a malformed `Init` and `4500` when the provider could not decide (`cratestack-webtransport/src/admission.rs`). `Init` is id 0 and `Ready{0}` acknowledges it, so the frame already exists in the protocol. The same applies to a refused re-authentication. Challenges are not carried (Q5) |
| WebTransport subscription (op level) | A policy or setup refusal from the `SubscriptionDispatcher` is an `err` frame built by `RpcErrorBody::from_cratestack`, so #1208's members already reach the client | As built |
| WebSocket (design only, `docs/design/subscriptions-websocket.md` §6.3) | Designed to close with `4401` | Mirrors WebTransport: `Error{id: 0}` with the refusal's body, then close |
| COSE envelope layer (ADR 0006) | Not an `AuthProvider`. A request that does not verify gets one coarse, unsigned 401, whatever the envelope reported (ADR 0006 §10, D4) | Unchanged, by ADR 0006. The kit does not cover it |
| Embedded (`include_embedded_schema!`) | No authentication and no policy enforcement, by design | Not applicable |

Sources for the WebTransport rows: #1238 and `docs/design/subscriptions-websocket.md` §6.3, §6a.2 and
§6a.4 on its branch, plus the statement of that PR's author for this ADR. This ADR does not change #1238.

A frame has no header, so challenges cannot reach a WebTransport or WebSocket client today. Whether
`RpcErrorBody` should carry them is Q5.

### 2. The principal contract (D2)

#### Reserved names

These top-level claim names are reserved. A provider that sets one must give it the listed type. Any
other name stays free-form and keeps today's behaviour. The names follow the JWT and OIDC registries in
their registered spelling (`auth_time`, not `authTime`), even though `cratestack-auth`'s product claims
are camelCase.

| Name | Type | Meaning | Source |
|---|---|---|---|
| `sub` | string | The stable subject identifier. What the framework itself uses as "who": audit actor, rate-limit and idempotency principal, WebTransport and sync session owner | RFC 7519 §4.1.2 |
| `roles` | list of strings | The caller's roles | — |
| `role` | string | Legacy single role, still read | today's convention |
| `tenant.id` | string | The tenant, in the existing `tenant` facet | today's convention |
| `auth_time` | integer, seconds since the epoch | When the user last actively authenticated | OIDC Core §2 |
| `amr` | list of strings | Authentication methods, RFC 8176 values (`hwk`, `user`, `pwd`, `otp`, `face`, …) | RFC 8176 |
| `acr` | string | Authentication context class | OIDC Core §2 |
| `cnf` | map | Proof-of-possession confirmation, with RFC 7800 member names. `cnf.jkt` is the JWK SHA-256 thumbprint, base64url (RFC 9449 §6, RFC 7638). A COSE key thumbprint (RFC 9679) goes under its own member (Q7) | RFC 7800 |
| `key_role` | string, `ambient` or `user_present` | Which device key proved *this request*: one that never prompts, or one that prompts for user presence on every signature (fespalier's `KeyRole`) | — |
| `exp` | integer, seconds since the epoch | When the authentication expires. Read only by long-lived transports (subscriptions), which close at that instant | RFC 7519 §4.1.4 |

`id` is **not** reserved. Many schemas declare `auth SessionUser { id Int … }`, and reserving it with a
fixed type would break them. It stays a free-form, schema-typed claim, and the framework's own "who"
reads fall back to it (below).

A value of the wrong type reads as absent. Every reader therefore fails closed: `hasRole` on a `roles`
that is not a list of strings is false, and so is `inTenant` on a numeric `tenant.id`.

#### A builder and typed readers in core

`cratestack-core` gains a builder, so a provider does not have to know the facet layout:

```rust
let ctx = CratestackContext::builder("user-42")         // sub
    .roles(["admin", "teller"])
    .tenant("acme")                                     // tenant.id
    .auth_time(1_793_000_000)
    .amr(["hwk", "user"])
    .acr("urn:example:loa:2")
    .cnf_jkt(jwk_thumbprint)                            // base64url
    .key_role(KeyRole::UserPresent)
    .claim("kycStatus", Value::String("verified".into())) // free-form
    .build();
```

It fills the same `auth` and `principal` the existing constructors fill, so `auth().<path>` and every
existing reader see the result. It sets no private fact: the system flag and the verified signer stay
out of a provider's reach.

Typed readers on `CratestackContext` return `None` for an absent or mistyped claim: `subject()`,
`roles()`, `auth_time()`, `amr()`, `acr()`, `cnf_jkt()`, `key_role()` and `expires_at()`. The exact
names are left to the implementation.

#### How the readers use it

- **`subject()`** reads `sub`, then `actor.id`, then `id`, and renders an integer as its decimal
  digits (MCP's `principal_id` rule). Every framework read of "who" moves to it:
  `principal_actor_id()`, the MCP admission key, and the WebTransport session key and
  principal-change check. `cratestack-sync`'s principal resolver defaults to it. Today these readers
  disagree on the order and on integer ids. A provider that sets `sub` gets the same answer
  everywhere.
- **`hasRole(r)`** is true when `roles` contains `r`, or `role` equals `r`, or `actor.role` equals `r`.
  The two legacy reads stay, so no existing policy changes meaning.
- **`inTenant(t)`** reads `tenant.id`, unchanged.
- **`auth().<path>`** is unchanged: the schema's `auth` block declares what a policy may read. A
  schema that declares a reserved name must declare it with the contract's type (for example
  `roles String[]`), and the semantic checker says so. The policy operators that compare `auth_time`
  or test membership in `amr` are #1244's grammar, not this ADR's.

#### The product-specific mapping in `cratestack-auth`

`principal_to_cratestack_context` keeps its current shape, because Webank's policies read it
(`auth().actor.id`, `kycStatus`, `session.boundKeyId`). The change is additive:

1. It also emits the contract names it knows: `sub` (the user id, or `svc:<key id>` for a service
   caller), `roles` (from the verified `role` claim), and `cnf` from the id-token's key binding.
   `auth_time` and `amr` are #1244's child story 8.
2. A second mapper emits **only** the contract names plus the free-form claims a deployment selects,
   for applications that are not Webank.
3. `SignedRequestAuthProvider` takes the mapper as configuration. Which one is the default is Q2.

`CoseAuthProvider`'s signer principal moves to the builder too: `sub` is `cose:<thumbprint>` (the
string its `id` already carries, and the envelope layer's default rate-limit principal), and the
COSE key thumbprint goes into `cnf` (Q7).

### 3. Canonical request versus wire request (D3)

A provider that verifies a signature needs to know exactly which request it is given. Today that is
true by construction in the generated code, but it is written down only in code comments, and one
caller (sync) passes the wire path instead.

**The rule.** The `RequestContext` a provider receives is the **canonical request** of the operation,
and a client signs the same thing:

1. **`method`** is the operation's declared method, not whatever the client sent: `POST` for every
   RPC call, `GET` for a subscription, `CONNECT` for a WebTransport session.
2. **`path`** is the route CrateStack declares, relative to the router's own root. **A mount prefix
   never appears**: a router nested under `/api` hands the provider `/rpc/<op_id>`, not
   `/api/rpc/<op_id>`. A client signs its request path minus the base URL's path. The internal
   `/$procs/...` path never appears on `transport rpc` either.
3. **`query`** is the raw query string exactly as received, where the operation reads one (REST model
   reads, and a WebTransport CONNECT, whose `?codec=cbor|json` is the fallback for a client that cannot
   negotiate the subprotocol), and `None` everywhere else.
4. **`body`** is the exact bytes the router received, before decoding, and never re-encoded. Behind
   the COSE envelope layer that is the opened payload. A provider that needs the sealed message reads
   the recorded `VerifiedSigner`, not the body.
5. **`headers`** and **`extensions`** are the request's own. A synthesized request (a WebTransport
   `Init`) says in its transport's documentation which headers it substitutes.

Per transport:

| Transport | `method` | `path` | `query` | `body` |
|---|---|---|---|---|
| REST procedure | `POST` | the declared route | `None` | wire bytes |
| REST model | the route's method | the declared route, plus `/<id>` | raw query | wire bytes, or empty |
| RPC unary | `POST` | `/rpc/<op_id>` | `None` | the raw frame bytes |
| RPC batch | `POST` | `/rpc/batch` | `None` | the whole batch body; authenticated once, frames never re-authenticated |
| SSE subscription | `GET` | `/rpc/subscribe/<op_id>` | `None` | empty |
| MCP Streamable HTTP | `POST` | the path of the configured resource identifier, fixed at build time | raw query | wire bytes (bounded) |
| sync | the route's method | `/sync/register`, `/sync/push`, `/sync/pull` or `/sync/poke` | raw query | wire bytes |
| WebTransport | `CONNECT` | the configured session path (`/rpc/wt`, or `/$wt` for REST schemas) | raw query | empty |
| WebSocket (design) | `GET` | `/rpc/ws` | `None` | empty |

Three call sites change to meet it: sync passes `parts.uri.path()` and should pass its constant route;
WebTransport passes an empty `extensions` and should pass at least the peer address; and the REST model
`/<id>` segment is the *decoded* id, not the wire bytes (Q6). WebTransport's path already meets the
rule: a CONNECT to any other path is refused with `404` before authentication, and the binding is its
own QUIC listener, so there is no mount prefix to strip.

### 4. MCP credential presence (D4)

Today MCP requires `Authorization: Bearer` before the provider runs, so a device-signature or COSE
provider can never authenticate an MCP call. The Bearer check does three things worth keeping: a
missing credential gets a 401 challenge with no `error` (RFC 6750 §3.1), a malformed one gets a 400
`invalid_request`, and the token is redacted from logged provider errors.

#### As built in #1246: a builder option

MCP credential presence is chosen on `StreamableHttpServer::with_credential_presence`:

| Rule | Behaviour |
|---|---|
| `CredentialPresence::bearer()` | The default: today's Bearer check, unchanged |
| `CredentialPresence::provider_decides()` | Every request reaches the provider, which alone decides; a request without a credential costs a body read and a provider call before its 401 |
| `CredentialPresence::when(\|parts\| ..)` | A predicate over the request head (method, URI, headers, extensions; never the body) |
| `.with_credential_headers([...])` | The headers that carry a non-Bearer credential: stripped before `rmcp` sees the request, as `Authorization` is, and their values redacted from the provider's logged detail |

A request found without a credential still gets the Bearer challenge with `resource_metadata`. Two
`Authorization` headers are still a 400 under every rule. The challenge carries an `error` only when
the request actually sent a bearer token.

This was chosen over the trait method below for the first slice because it touches only MCP, changes
no trait, and lets a deployment use a provider it does not own (an external library's) without
wrapping it. Its limit: the provider cannot say *why* a credential is malformed (`Malformed` below),
and nothing outside MCP can ask a provider whether it has a credential.

#### As built: a defaulted trait method, for the chain (D5)

The first-success chain (§5) must skip a provider that has no credential without calling it, which
needs the provider, not the deployment, to answer. So `AuthProvider` gains a defaulted method
(cratestack#1243, story 7):

```rust
fn credential<'r>(&self, request: &RequestContext<'r>) -> Credential<'r> {
    Credential::Unknown
}

#[non_exhaustive]
pub enum Credential<'r> {
    Unknown,
    Absent,
    Present { redact: Option<&'r str> },
    Malformed(&'static str),
}
```

**The default is `Unknown`, not `Credential::bearer` as first proposed.** With a bearer default, a
provider that reads a cookie or a signature and does not implement the method would be skipped,
silently, by every chain it is put in. `Unknown` means "call me": a chain always calls such a member,
and MCP under `ask_provider()` (below) sends the request on, as `provider_decides()` does. Adding a
defaulted method is not a breaking change, and no existing provider changes behaviour anywhere.
`Credential::bearer(headers)` and `Credential::header(headers, name)` are helpers a provider returns.
A device-signature provider answers `Present` when its signature header is there; `CoseAuthProvider`
answers `Present` when a verified signer is in the extensions.

The answer is read from the request head: the body may be empty when the provider is asked.

**ADR 0002's posture is kept.** ADR 0002 makes the MCP endpoint an OAuth 2.1 resource server: a 401
with `WWW-Authenticate` naming `resource_metadata`, Protected Resource Metadata, an identity required
after authentication, and no token in the query. Accepting a non-Bearer credential departs from the MCP
authorization specification, so it is opt-in:

- By default the MCP service uses `Credential::bearer` whatever the provider says. The MCP conformance
  job keeps testing a spec-conformant server.
- A deployment that opts in with `CredentialPresence::ask_provider()` asks `provider.credential(..)` instead.
  `Absent` still gets the Bearer challenge with `resource_metadata`, so OAuth clients still discover
  the authorization server; `Malformed` is a 400 `invalid_request`; `Present { redact }` runs the
  provider and redacts that string from logged detail; `Unknown` runs the provider, as
  `provider_decides()` does.
- An anonymous answer is still a 401, the query-token refusal stays, and refusals render as in §1.

This touches MCP deliberately, as ADR 0002 D5 requires for any extension of MCP. As built,
`ask_provider()` is a fourth `CredentialPresence` rule rather than a change to `provider_decides()`,
which keeps always calling `authenticate`: a deployment chooses which, and the default stays `bearer()`
(Q10).

### 5. Composition (D5)

*Built in story 7 (cratestack#1243).* `cratestack-core` gains a first-success chain, replacing hand-written wrappers such as
`CoseAuthProvider`'s:

```rust
let auth = first_success(oauth).or(device_signature).or(cose_signer);
```

The rules, in order, for each member:

1. If `credential()` says `Absent`, skip it without calling `authenticate`. A strict provider that
   refuses a request without its credential can therefore sit in a chain.
2. If it returns an authenticated context, return it.
3. If it returns an error (a refusal or otherwise), return that error. **A credential one provider
   refuses is never rescued by another**: that is `CoseAuthProvider`'s rule 1, and it fails closed.
4. If it returns an anonymous context, go on to the next.

If no member authenticates, the chain answers with the first anonymous context a member returned
(so what a provider put in it is kept), and policy decides. The chain's own
`credential()` is `Present` if any member's is, carrying the first member's `redact`. It is
generic and static (nested types: `first_success(a).or(b).or(c)` is a
`FirstSuccess<Or<Or<A, B>, C>>`, no `dyn`), because `AuthProvider` returns
`impl Future` and is not object-safe. A request that presents two credentials is resolved by order
(Q8).

`CoseAuthProvider` is rewritten as `first_success(inner).or(signer_provider)`, which is the epic's
"in-house auth uses only the public seam" in practice.

### 6. The conformance kit (D6)

*Built in story 8 (cratestack#1243), as the crate `cratestack-auth-conformance`.* Two departures from
the text below: the kit is a dev-dependency of its own, not a `testing` feature of the facades (the
kit compiles schemas with `include_server_schema!`, so it depends on a facade, and a facade feature
re-exporting it would be a dependency cycle); and it drives REST, RPC unary, RPC batch and MCP but
not yet SSE model subscriptions or sync, which need a database. `CoseAuthProvider` passes it.

A provider author, in-house or external, writes one test:

```rust
#[tokio::test]
async fn my_provider_conforms() {
    cratestack::testing::auth_conformance(MyProvider::new(keys))
        .accepts(|canonical| sign(canonical))                // a valid credential for this request
        .refuses(|canonical| expired(canonical), expected)   // a refused credential and its AuthRefusal
        .run()
        .await;
}
```

The kit compiles its own small schema and drives the provider through every transport the enabled
features offer: REST, RPC unary, RPC batch, the `@stream` procedure path, MCP Streamable HTTP (feature
`mcp`), and, with a database, SSE model subscriptions and sync. WebTransport and WebSocket join when
their bindings ship. It mounts each router both at the root and under a prefix. It asserts:

- the **same verdict** on every transport: an accepted credential yields the same `subject()`, and a
  refused one the same refusal;
- the **same rendering**: status, RPC or REST code, message, members, `details` and challenges, per
  the matrix in §1 (whole-batch for batch, the MCP challenge first on MCP);
- the **canonical request** of §3 exactly, including the body bytes and the absence of the mount
  prefix;
- **one call per request**: a batch is authenticated once, and a skipped chain member is not called;
- **nothing leaks**: an `Internal` error from the provider stays canned, and a refusal's members can
  never replace `code`, `message` or `details`.

It ships behind a `testing` feature on the `cratestack-pg` and `cratestack-api` facades, the crates a
provider's tests already depend on, so that a dev-dependency switches it on and nothing ships in a
release graph. Where its code lives (a new crate the feature pulls in, or a module of an existing
one) is Q9. Database-backed cases follow the repository's PG-test convention: they skip without
`CRATESTACK_TEST_DATABASE_URL`, and fail instead under `CRATESTACK_REQUIRE_DB=1`.

`SignedRequestAuthProvider` and `CoseAuthProvider` must pass it. So must the external-library example
(§7).

### 7. The independence guarantee (D7)

*The guard is built (cratestack#1243): `.ci/auth-independence-check.sh`, CI job `auth library
independence (ADR 0021)`, fails when the workspace's `Cargo.lock` holds an `authkestra*` package.
The lockfile is the resolved graph of every member under every feature, so one check covers the
`cargo metadata` and `cargo tree` assertions below. The example side is built too (cratestack#1245):
`.ci/auth-pluggable-check.sh`, in CI job `auth-pluggable`, runs `cargo tree` inside
`examples/auth-pluggable` on every CrateStack crate in its graph and fails if one reaches an
`authkestra*` package; it also requires that the example itself does, and that its `src/` names no
`__private` path. The example's three providers pass the kit.*

**No framework crate depends on any authentication library**, directly or transitively, under any
feature. The seam's types (`AuthRefusal`, the principal contract, `Credential`, the chain) live in
`cratestack-core`, which respects ADR 0013 (facade disjointness) and ADR 0014 (layer direction);
in-house auth stays at L1 and depends only on core.

The proof follows `examples/client-only-verification`:

- The example that wires an external library is **excluded from the workspace**, with its own
  `[workspace]` root and lockfile, so Cargo's feature unification cannot hide anything. The epic's
  child story 10 is superseded by
  [cratestack#1245](https://github.com/cratestack/cratestack/issues/1245)'s `examples/auth-pluggable`
  (one schema, three providers: in-house, Authkestra devsig, Authkestra OIDC), so the two are built
  once.
- A CI job asserts, from the workspace root, that no workspace member's dependency graph contains an
  `authkestra` package (`cargo metadata` over every member, and `cargo tree --workspace -i` per known
  package name, which must find nothing), and, from the example's root, that it does. The second
  assertion keeps the first from passing because the example quietly stopped using the library.
- The example uses only public facade paths: a grep of its `src/` for `__private` must find nothing.
- The example runs the conformance kit.

The guard names Authkestra because it is the library in the programme. Its rule is general, and a
deny-list in `deny.toml` is the alternative if more libraries need guarding.

## Consequences

**Benefits:**

- A code-classifying or non-Bearer scheme needs no tower layer in front of the router.
- An external library and the in-house providers use the same public surface, proven by one kit.
- Every framework read of "who" agrees, and policies keep their meaning.
- #1244 gets the claims (`auth_time`, `amr`, `acr`, `key_role`) and the refusal channel it needs.

**Costs:**

- Two new public concepts in core (`Credential`, the builder) and one defaulted trait method.
- Reserved names constrain what a schema's `auth` block may declare under those names.
- The kit must grow with every transport. A transport it does not drive is a transport where parity is
  unproven.
- The sync error body grows a `forbidden` code and members, which is a sync protocol change.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Depend on Authkestra, or delegate authentication to it | Rejected by the maintainer (2026-10-28). It would tie CrateStack's release cadence and graph to one library, and leave every other library a second-class citizen |
| Let a provider choose the wire `code` | Breaks every client that switches on `UNAUTHORIZED` / `unauthenticated`. A member carries the reason without that cost (#1208) |
| `From<AuthRefusal> for CratestackError` | Makes inferred `?` ambiguous (E0283) in generated and application code. `into_error()` is explicit and costs one call |
| A per-frame refusal for batch | A batch has one envelope and one verdict. Repeating it per frame under a `200` hides the status and challenges, and a signing provider cannot verify a frame it never signed |
| Reserve `id` as the subject | Too many schemas already declare `id Int`. `sub` is the registered name and collides with nothing in use |
| A fully typed principal struct instead of reserved names | Forces every product into one shape, which is exactly what the epic is undoing in `cratestack-auth` |
| Drop MCP's Bearer requirement outright | Departs from the MCP authorization specification for every deployment, including those that rely on it. Opt-in keeps ADR 0002's posture |
| A `dyn` provider list for composition | `AuthProvider` returns `impl Future` and is not object-safe; a static chain needs no boxing |

## Open questions for the maintainer

| # | Question | Recommendation |
|---|---|---|
| Q1 | Confirm the batch rendering: the epic says "per-frame for batch", #1208 built a whole-batch refusal | Whole batch, as built (§1) |
| Q2 | Which `cratestack-auth` mapper is the default: today's product shape plus the contract names, or the contract-only mapper? | Today's shape plus contract names for one release, then decide with Webank |
| Q3 | Is `key_role` needed, or is it derivable from `amr` (`hwk` plus `user` for a user-present signature)? | Keep it: `amr` describes the authentication event, `key_role` the key behind this one request; #1244's step-up rules need the second |
| Q4 | WebTransport and WebSocket: which close code for a 403 refusal? `4403` today means "re-authentication named another principal" | `4403` for both, since the `{id: 0, err}` frame before the close says which. A client reads that frame, when present, rather than the close code alone: `4401` also closes a session that sent no `Init` within `init_timeout` (10 s), which is not a provider's verdict |
| Q5 | Should `RpcErrorBody` carry challenges, so a frame-based transport can deliver them? | Not now. No frame-based client parses challenges, and #1244's step-up signal travels in `details` |
| Q6 | The REST model `/<id>` path segment is the decoded id, not the wire bytes. Keep it, or sign the percent-encoded form? | Keep the decoded id and document it; the kit pins it |
| Q7 | Under which `cnf` member does a COSE key thumbprint (RFC 9679) go? | The confirmation-method name RFC 9679 registers in the CWT registry (`ckt`, to be checked against the RFC's IANA section before acceptance), lowercase hex as `CoseAuthProvider` emits today, or base64url to match `jkt` |
| Q8 | A request that presents two credentials (a Bearer token and a signature): resolve by chain order, or refuse as ambiguous? | Chain order, documented |
| Q9 | Where does the kit's code live? | A new `cratestack-auth-conformance` crate at the test-support layer, re-exported by the facades' `testing` feature |
| Q10 | Should MCP's provider-decided credential check be on by default once the kit covers it? | No. Off by default, for spec conformance |

## Implementation plan

The epic's child stories, in dependency order:

1. This ADR.
2. `AuthRefusal`, REST and RPC unary: **built** (#1208, in #1246).
3. RPC batch, SSE, middleware and sync rendering (§1): **built** in #1246.
4. MCP refusal rendering and `CredentialPresence` (§1, §4): **built** in #1246. The defaulted
   `AuthProvider::credential` method moves to story 7, with the chain that needs it.
5. The principal contract, builder and readers; `hasRole` over `roles` (§2): **built** in #1250.
6. The canonical-request rule and its tests; the sync and WebTransport call sites (§3): **built** in #1248.
7. The first-success chain (§5), with the defaulted `AuthProvider::credential` method (§4): **built** in #1248.
8. The conformance kit (§6): **built** in #1251.
9. `SignedRequestAuthProvider` and `CoseAuthProvider` onto the public seam, passing the kit: **built** in #1251.
10. The independence guard, with #1245's `examples/auth-pluggable` (§7): **built** in #1251 and #1254.
11. Generated clients: the refusal's members and `details` typed on `CratestackRestException` and
    `CratestackRpcException`, in Rust, Dart and TypeScript together (transport parity): **built** in
    #1249.

Every story above shipped in CrateStack 0.17.1.

Each story that adds a `### ` entry under the framework's `## Unreleased` declares its docs and skills
companions ([cratestack-docs#139](https://github.com/cratestack/cratestack-docs/issues/139),
[cratestack-skills#41](https://github.com/cratestack/cratestack-skills/issues/41)).
