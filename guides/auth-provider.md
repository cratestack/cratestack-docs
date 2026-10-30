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
