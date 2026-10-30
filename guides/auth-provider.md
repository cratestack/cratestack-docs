# Auth Provider

CrateStack does not authenticate requests itself.

The host application is responsible for:

* reading headers, cookies, bearer tokens, signed requests, or other transport-specific auth material
* validating that material
* projecting the authenticated principal into a CrateStack auth context

The framework boundary for that is `cratestack::AuthProvider`.

## Trait shape

Implement one trait per host auth strategy:

```rust
use cratestack::{AuthProvider, CratestackContext, RequestContext};

#[derive(Clone)]
struct AppAuthProvider;

impl AuthProvider for AppAuthProvider {
    type Error = cratestack::CratestackError;

    fn authenticate(
        &self,
        request: &RequestContext<'_>,
    ) -> impl core::future::Future<Output = Result<CratestackContext, Self::Error>> + Send {
        let result = resolve_context_from_request(request);
        core::future::ready(result)
    }
}
```

`CratestackContext` and `RequestContext` are two distinct types, easy to conflate by name alone: `RequestContext` is the *inbound* view (`method`/`path`/`headers`/`body`) the provider reads from, while `CratestackContext` is the *outbound* auth/principal result the provider produces. `authenticate(...)` takes one and returns the other.

`RequestContext` gives the provider a framework-owned request view:

* `method`
* `path`
* `query`
* `headers`
* `body`

This keeps auth resolution outside generated handlers while avoiding direct dependency on a specific host framework request type.

## Router usage

Register the provider once when building generated routes:

```rust
let router = cratestack_schema::axum::router(
    db,
    procedures,
    CborCodec,
    AppAuthProvider,
);
```

Generated CRUD and procedure routes will call `authenticate(...)` for each request and use the resulting `CratestackContext` for schema policy enforcement.

## Refusing a request

*(Unreleased, [cratestack#1208](https://github.com/cratestack/cratestack/issues/1208).)* A provider refuses by returning an error. `CratestackError::Unauthorized` and `Forbidden` give the standard envelope and nothing more:

```json
{ "code": "UNAUTHORIZED", "message": "no credential", "details": null }
```

That is enough for a client that only needs "signed in or not". When the client must act on *why* (renew a credential and retry once, sign out and wipe its keys, re-authenticate more strongly), return an `AuthRefusal` instead:

```rust
use cratestack::{AuthRefusal, Value};

return Err(AuthRefusal::unauthenticated("attestation expired")
    .with_member("error", Value::String("attestation_expired".into()))
    .with_challenge(r#"Signature error="attestation_expired""#)
    .into_error());
```

* `into_error()` turns the refusal into the `CratestackError` the provider returns. There is no `From` conversion, so `?` and `.into()` do not apply.
* `AuthRefusal::unauthenticated(message)` is a `401` and `AuthRefusal::forbidden(message)` a `403`. The code stays `UNAUTHORIZED` / `FORBIDDEN` (RPC: `unauthenticated` / `permission_denied`), so a client that ignores the rest reads the refusal as before.
* `with_member(name, value)` adds a top-level member next to `code` and `message`. The names `code`, `message` and `details` are ignored: a refusal cannot replace them.
* `with_details(value)` sets `details`.
* `with_challenge(value)` adds a `WWW-Authenticate` header (an RFC 6750 or RFC 9470 challenge, for instance). A value that is not printable ASCII is ignored.

The REST response for the refusal above:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Signature error="attestation_expired"

{ "code": "UNAUTHORIZED", "message": "attestation expired", "details": null, "error": "attestation_expired" }
```

RPC sends the same status, members and header, with the RPC code (`{"code": "unauthenticated", ...}`). A `POST /rpc/batch` is authenticated once, before any frame runs, so a refusal answers the whole batch the same way.

The Rust types gained a field for this: `CratestackErrorResponse` and `RpcErrorBody` carry the members in `extra`, and an envelope read from the wire collects there every member it does not know. An envelope without extra members is encoded byte for byte as before, in JSON and in CBOR.

### Reading a refusal in a generated client

*(Unreleased, [cratestack#1243](https://github.com/cratestack/cratestack/issues/1243).)* Every generated client types the same five things on both transports: the wire `code`, `message`, `details`, every other member (`extra`, never dropped, CBOR or JSON) and the `WWW-Authenticate` challenges (raw, unparsed).

| Client | REST error | RPC error |
|---|---|---|
| Rust | `ClientError::Remote`: `remote_error()` (the `CratestackErrorResponse`: `code`, `message`, `details`, `extra`) and `challenges()` | `RpcClientError::Remote(RpcRemoteError)`: `body` (`RpcErrorBody`: `code`, `message`, `details`, `extra`) and `challenges`; `RpcClientError::challenges()` |
| Dart | `CratestackRestException`: `code`, `message`, `details`, `extra`, `challenges`, `headers` (and the raw `body`) | `CratestackRpcException`: `code`, `message`, `details`, `extra`, `challenges`, `headers`; `RpcErrorBody.extra` |
| TypeScript | `CratestackHttpError`: `body` (`CratestackErrorResponse`), `code`, `details`, `extra`, `challenges` (and the raw `payload`) | `CratestackRpcError`: `code`, `details`, `body`, `extra`, `headers`, `challenges` |

```dart
try {
  await client.accounts.get(7);
} on CratestackRpcException catch (e) {
  if (e.code == CratestackRpcErrorCodes.unauthenticated &&
      e.extra['error'] == 'attestation_expired') {
    // renew the credential and send again, once
  }
}
```

Two refusal lines of `WWW-Authenticate` reach Rust as two values. The Dart HTTP seam and the browser's `Headers` join a repeated header with `, `, so Dart and TypeScript see one value holding both. An error inside a batch frame or a stream's final item has no headers of its own, so its `challenges` is empty. The `--rtk` REST error (`RtkRestQueryError`) carries `code`, `extra` and `challenges`; `--swr` hooks surface the same error instances. In Rust, `ClientError::Remote` and `RpcRemoteError` gained a `challenges` field, so a pattern that names every field without `..` needs one.

The MCP transport renders a refusal the same way (status, members, `details`, challenges after its own `resource_metadata` one); see [MCP](./mcp#a-provider-that-does-not-use-bearer-tokens). So do the prototype sync endpoints, whose error body carries the members next to its `code`, with a new `forbidden` code for a `403`.

## What the provider is given

*(Unreleased, [cratestack#1243](https://github.com/cratestack/cratestack/issues/1243).)* The
`RequestContext` is the **canonical request** of the operation. A provider that verifies a
signature can rely on it, and a client signs the same thing:

| Transport | `method` | `path` | `query` | `body` |
|---|---|---|---|---|
| REST procedure | `POST` | the declared route, e.g. `/$procs/whoAmI` | `None` | the wire bytes |
| REST model | the route's method | the declared route, with the **decoded** `/<id>` | the raw query | the wire bytes, or empty |
| RPC unary | `POST` | `/rpc/<op_id>` | `None` | the raw frame bytes |
| RPC batch | `POST` | `/rpc/batch` | `None` | the whole batch body, authenticated once |
| SSE subscription | `GET` | `/rpc/subscribe/<op_id>` | `None` | empty |
| MCP Streamable HTTP | `POST` | the path of the resource identifier | the raw query | the wire bytes |
| sync | the route's method | `/sync/register`, `/sync/push`, `/sync/pull` or `/sync/poke` | the raw query | the wire bytes |

**A mount prefix never appears.** A router nested under `/api` hands the provider `/rpc/<op_id>`,
not `/api/rpc/<op_id>`, so a client signs its request path minus its base URL's path. The body is
the bytes the router received, before decoding and never re-encoded; behind a COSE envelope layer
it is the opened payload.

## Saying whether a request carries a credential

*(Unreleased, [cratestack#1243](https://github.com/cratestack/cratestack/issues/1243).)* A provider
may also say, without authenticating, whether a request carries its kind of credential:

```rust
use cratestack::{AuthProvider, Credential, RequestContext};

impl AuthProvider for DeviceSignatureProvider {
    // type Error and authenticate(...) as above

    fn credential<'r>(&self, request: &RequestContext<'r>) -> Credential<'r> {
        Credential::header(request.headers, "x-signature")
    }
}
```

* `Credential::Unknown` is the default when a provider does not implement the method: it is always called, as before.
* `Credential::Absent`: the request carries none of this provider's credentials.
* `Credential::Present { redact }`: it carries one. `redact` is a value to cut out of logged error detail, such as a token.
* `Credential::Malformed(reason)`: it carries one the provider will not read.
* `Credential::bearer(headers)` reads an `Authorization: Bearer` token as MCP does, and `Credential::header(headers, name)` a credential carried in one header.

The answer is read from the request head. The body may be empty when the provider is asked, so a
provider never looks for its credential there. Two things ask: a
[first-success chain](#composing-providers), and MCP under
[`CredentialPresence::ask_provider()`](./mcp#a-provider-that-does-not-use-bearer-tokens).

## Composing providers

*(Unreleased, [cratestack#1243](https://github.com/cratestack/cratestack/issues/1243).)* An
application that accepts more than one kind of credential composes its providers into one:

```rust
use cratestack::first_success;

let auth = first_success(oauth).or(device_signature).or(cose_signer);
let router = cratestack_schema::axum::router(db, procedures, CborCodec, auth);
```

Each member is asked in order:

1. If its `credential` is `Absent`, it is skipped without being called.
2. If it returns an authenticated context, that is the answer.
3. If it returns an error, that is the answer. **A credential one member refuses is never rescued by another**: the chain fails closed.
4. If it returns an anonymous context, the next member is asked.

When no member authenticates, the chain answers with the first anonymous context a member returned
(so its extensions, such as a client IP, are kept), and the schema's policies decide. A
request that carries two credentials is resolved by order: the first member that authenticates it
wins. A member that does not implement `credential` (`Unknown`) is always called, so put a strict
provider that refuses a request without its credential after the members it should not shadow, or
give it a `credential` method.

The chain is static (`first_success(a).or(b)` is a `FirstSuccess<Or<A, B>>`), because
`AuthProvider` is not object-safe. Its error type is `CratestackError`.

## Internal callers

Non-HTTP Rust callers can bind auth directly:

```rust
let bound = db.bind_auth(Some(serde_json::json!({
    "id": 7,
    "role": "admin",
})))?;

let posts = bound.post().find_many().run().await?;
```

Use `bind_context(...)` when the host already has a `CratestackContext`.

## Principal projection

`bind_auth(...)` accepts any `serde::Serialize` principal that serializes to a JSON object.

Example:

```rust
#[derive(serde::Serialize)]
struct Principal {
    id: String,
    role: String,
    tenant_id: String,
}
```

That object is normalized into a `CratestackContext` principal surface with two layers:

* a structured principal model with `actor`, `session`, `tenant`, and free-form `claims`
* a legacy auth projection so existing `auth().field` policies keep working

Schema expressions can continue to use the familiar `auth()` shape:

```cstack
@@allow("read", auth() != null && published)
@@allow("update", authorId == auth().id)
@@allow("delete", auth().role == "admin")
@@allow('all', auth() != null && auth().id == authorId)
@@deny('all', auth().organization.id != organizationId)
organizationId String? @default(auth().organization.id)
```

Write each rule exactly in this form, one per line: `@@allow` / `@@deny`, then `(`, a quoted
action, a comma and the expression, with nothing after the `)`. Through 0.14.0 a rule written any
other way (`@@deny ("read", …)`, `@@Deny(…)`, a trailing `;`, a misspelt action) still checked as
`schema OK` but was skipped, and so was the exact form followed by a `// comment`; either way the
model was more permissive than written. Since 0.14.1 such a rule is refused, and a
trailing `// comment` is stripped, so the commented form works. See
[Policy attribute spelling](../reference/auth-support-matrix#policy-attribute-spelling).

Structured principals can also carry first-class facets explicitly:

```rust
#[derive(serde::Serialize)]
struct Principal {
    actor: Actor,
    session: Session,
    tenant: Tenant,
    role: String,
}
```

When those top-level keys are present, `CratestackContext::from_principal(...)` promotes them into the structured `principal.actor`, `principal.session`, and `principal.tenant` slots while still projecting the same data back through legacy `auth()` lookups for schema compatibility.

Current auth-derived create defaults are intentionally conservative:

* `@default(auth().field)` only
* nested auth paths like `@default(auth().organization.id)` are supported
* no arbitrary expressions or function calls inside `@default(...)`
* currently limited to `String`/`Cuid`, `Int`, and `Boolean` model fields

For the broader supported policy matrix, precedence rules, and explicit not-supported cases, see `../reference/auth-support-matrix.md`.

## The principal contract

*(Unreleased, [cratestack#1243](https://github.com/cratestack/cratestack/issues/1243), ADR 0021 §2.)* A few top-level claim names are reserved, each with a fixed type. A provider that sets one must give it that type; every other name stays free-form.

| Name | Type | Meaning |
|---|---|---|
| `sub` | string | The subject: what the framework itself uses as "who" |
| `roles` | list of strings | The caller's roles |
| `role` | string | Legacy single role, still read |
| `tenant.id` | string | The tenant, in the `tenant` facet |
| `auth_time` | integer, seconds since the epoch | When the user last actively authenticated |
| `amr` | list of strings | Authentication methods (RFC 8176: `hwk`, `user`, `pwd`, `otp`, …) |
| `acr` | string | Authentication context class |
| `cnf` | map | Proof-of-possession confirmation (RFC 7800 members). `cnf.jkt` is the JWK SHA-256 thumbprint, base64url |
| `key_role` | `ambient` or `user_present` | Which device key proved this request |
| `exp` | integer, seconds since the epoch | When the authentication expires |

`id` is **not** reserved: `auth User { id Int }` keeps working.

### Building a context

`CratestackContext::builder(sub)` builds a context from these names without knowing the facet layout:

```rust
use cratestack::{CratestackContext, KeyRole, Value};

let ctx = CratestackContext::builder("user-42")         // sub
    .roles(["admin", "teller"])
    .tenant("acme")                                     // tenant.id
    .auth_time(1_793_000_000)
    .amr(["hwk", "user"])
    .acr("urn:example:loa:2")
    .cnf_jkt(jwk_thumbprint)                            // base64url
    .key_role(KeyRole::UserPresent)
    .expires_at(1_793_000_600)                          // exp
    .claim("kycStatus", Value::String("verified".into())) // free-form
    .build();
```

* `build()` fills `auth` and `principal` exactly as `CratestackContext::from_principal` does for the same claims, so `auth().<path>` in a policy and every existing reader see the result.
* `.cnf(member, value)` sets any other `cnf` member. `.tenant(..)` and the `cnf` setters merge into an existing map; every other setter replaces the earlier value.
* It never makes a system context (`auth().isSystem()` stays false) and never records a verified signer.

### Typed readers

Each returns `None` for an absent claim **and** for a claim of the wrong type, so a reader fails closed:

| Reader | Returns |
|---|---|
| `subject()` | `Option<Cow<str>>`: `sub`, then `actor.id`, then `id`; an integer `actor.id` or `id` as its decimal digits |
| `roles()`, `amr()` | `Option<Vec<&str>>`; `None` if any element is not a string |
| `auth_time()`, `expires_at()` | `Option<i64>` |
| `acr()`, `cnf_jkt()` | `Option<&str>` |
| `cnf(member)` | `Option<&Value>` |
| `key_role()` | `Option<KeyRole>` |

`subject()` is the one "who" the framework reads: the [audit log](./audit-log)'s actor id, the MCP idempotency and rate-limit namespace, and the sync engine's default principal (`SyncPrincipal::from_subject`, `cratestack_sync::server::subject_resolver`). `principal_actor_id()` answers the same and now returns `Option<Cow<str>>`.

### `hasRole` over `roles`

`hasRole("r")` is true when `roles` contains `"r"`, or `role` equals `"r"`, or `actor.role` equals `"r"`. The two legacy reads stay, and each is read on its own. A `roles` that is not a list of strings never grants.

### The `auth` block

A schema may declare a reserved name in its `auth` block, so a policy can read it with `auth().<name>`, but only with the contract's type:

```cstack
auth User {
  id        Int
  roles     String[]
  auth_time Int?
}
```

`cratestack check` refuses `roles String`, `auth_time String`, `cnf String`, or a `tenant` type whose `id` is not a string. `String`, `Cuid`, `Uuid` and a string enum count as strings; a `type` or `Json` counts as a map.

### `cratestack-auth`

`SignedRequestAuthProvider` takes the mapping from a verified principal to a context as configuration:

```rust
use cratestack_auth::{PrincipalMapper, SignedRequestAuthProvider};

let provider = SignedRequestAuthProvider::new(verifier)
    .principal_mapper(PrincipalMapper::contract(["kycStatus"]));
```

* `PrincipalMapper::product()`, the default, is today's shape (`actor`, `session`, `id`, `role`, `kycStatus`, …) plus the contract names: `sub` (the user id, or `svc:<key id>` for a service caller), `roles` (the verified `role`) and, for a user, `cnf` (`kid`, and `jkt` when the id token carried the key).
* `PrincipalMapper::contract([...])` emits only the contract names plus the product claims you name.
* `PrincipalMapper::custom(f)` takes your own function.

## Compatibility note

Exact auth keys still win before dotted traversal.

That means older flat claim maps such as `organizationId` can continue to work even while newer principals project nested structures such as `tenant.id` or `organization.id`.

The recommended direction for new integrations is:

* prefer structured principals with top-level `actor`, `session`, and `tenant` objects when those concepts exist
* treat ad hoc top-level scalar claims as compatibility or app-specific extensions rather than the long-term principal shape

CrateStack still accepts the older header-only resolver closure shape:

```rust
Fn(&HeaderMap) -> Result<CratestackContext, CratestackError>
```

through a compatibility blanket implementation.

Treat that closure form as legacy compatibility only.

New code should use an explicit `AuthProvider` type so auth behavior stays discoverable and reusable across routers, tests, and internal service boundaries.
