---
title: Computed Fields
description: "`@computed` — response-time fields backed by a generated resolver trait, with optional per-request parameters."
---

# Computed Fields

<Note>
`@computed` (with per-request `computedParams` and the typed client surfaces)
is available since **v0.8.11**; RPC `get` selection parity and the
`<Model>ComputedParams` builders since **v0.8.12**. It replaces the earlier
`@custom` attribute, which generated a resolver trait nothing ever called; a
schema still using `@custom` fails to parse with a pointer to `@computed`.
</Note>

Some fields are not stored and cannot be: a signed CDN URL that expires in
fifteen minutes, a display string assembled from three columns and the caller's
locale, a price converted at today's rate. Writing them into the table means
storing something already stale by the time it is read.

`@computed` declares such a field in the schema. The framework generates a
resolver hook, calls it while composing the response, and puts the result on the
wire — but never stores the field, never accepts it as input, and never lets you
filter or sort by it.

```cstack
model Image {
  id Int @id
  storageKey String
  proxyUrl String @computed
}
```

`Image.proxyUrl` is a real field to every client that decodes the response, and
does not exist as a column in Postgres.

## The generated resolver

Each `@computed` field adds one method to a per-schema `ComputedFieldResolver`
trait. The method name is `resolve_<owner>_<field>`, both parts snake-cased:

```rust
use cratestack_schema::ComputedFieldResolver;

#[derive(Clone)]
struct Resolvers {
    cdn_secret: Arc<str>,
}

impl ComputedFieldResolver for Resolvers {
    fn resolve_image_proxy_url(
        &self,
        db: &cratestack_schema::Cratestack,
        source: &cratestack_schema::Image,
        ctx: &cratestack::CratestackContext,
    ) -> impl Future<Output = Result<String, cratestack::CratestackError>> + Send {
        let key = source.storageKey.clone();
        let secret = self.cdn_secret.clone();
        async move { Ok(sign_url(&secret, &key)) }
    }
}
```

Four things are handed to every resolver:

1. `db` — the `Cratestack` handle, so a resolver may query. It runs *after* the
   originating operation, so the row it is enriching has already passed the
   model's read policy.
2. `source` — the **server-side** struct. Computed fields are absent from it (they
   are not stored), so `source` is exactly the persisted row.
3. `ctx` — the `CratestackContext` for the request, including auth. Use it to make
   a resolver caller-dependent.
4. `params` — only for parameterized fields; see below.

The trait requires `Clone + Send + Sync + 'static`, like the procedure registry.
Returning `Err(...)` maps to an error response through the normal
`CratestackError` status mapping.

### Schemas with no computed fields

The macro generates `impl ComputedFieldResolver for ()` whenever a schema
declares no `@computed` fields, so those schemas pass `()` and never write a
resolver:

```rust
cratestack_schema::axum::router(
    db,
    MyProcedures,
    (),                                   // <- computed-field resolver
    cratestack_codec_cbor::CborCodec,
    AppAuthProvider,
    cratestack::DEFAULT_BODY_LIMIT_BYTES,
);
```

The `resolvers` argument sits between the procedure registry and the codec on
`router`, `rpc_router`, `model_router`, and `procedure_router`.

## Where resolvers run

Computed fields are resolved everywhere a client decodes the owner:

| Surface | Resolved |
| --- | --- |
| `GET /<plural>/{id}`, `GET /<plural>` | yes |
| create / update / delete responses | yes |
| `include=<relation>` sub-objects | yes |
| procedure outputs — `T`, `T[]`, `Page<T>`, nested types | yes |
| RPC transport (`POST /rpc/{op_id}`, `/rpc/batch`) | yes |
| event / change-stream payloads | **no** |

Resolution happens after the database work, never before. On create, update, and
delete this means **the write has already committed when the resolver runs** — a
resolver that fails on a create returns an error response for a row that exists.
Keep resolvers side-effect free and treat their failure as a rendering failure,
not a transaction failure.

### Field selection skips resolvers

`?fields=` is honoured before the resolver is called, not after:

```http
GET /images/7?fields=id,storageKey
```

`proxyUrl` is excluded, so `resolve_image_proxy_url` is never invoked. This is
the mechanism to avoid paying for an expensive resolver on a listing that does
not need it. Computed field names are valid in `?fields=` and in
`includeFields[<relation>]`; they are never valid in filters or in `sort`,
because there is no column to filter or sort on.

## Parameterized resolvers

A resolver can take per-request arguments. Declare a params type and reference it
from the attribute:

```cstack
type ProxyParams {
  width Int?
  height Int?
}

model Image {
  id Int @id
  storageKey String
  proxyUrl String @computed(params: ProxyParams?)
}
```

The params type must be a declared `type`, must not itself contain computed
fields, and the trailing `?` is required — params are always optional in this
version, because a required parameter would make an ordinary CRUD read
unsatisfiable. The resolver gains one argument:

```rust
fn resolve_image_proxy_url(
    &self,
    db: &cratestack_schema::Cratestack,
    source: &cratestack_schema::Image,
    params: Option<&cratestack_schema::ProxyParams>,
    ctx: &cratestack::CratestackContext,
) -> impl Future<Output = Result<String, cratestack::CratestackError>> + Send {
    let width = params.and_then(|p| p.width).unwrap_or(1024);
    // ...
}
```

### On the wire

Read requests carry them in one query parameter, `computedParams`, whose value is
a URL-encoded JSON object keyed by computed field name:

```http
GET /images/7?computedParams=%7B%22proxyUrl%22%3A%7B%22width%22%3A800%7D%7D
```

decoded: `{"proxyUrl": {"width": 800}}`.

Rejected with a validation error: a value that is not a JSON object, a key that
names no computed field on this model, a key for a computed field that declares
no params type, a key for a field excluded by `?fields=`, and a params object
that does not deserialize into the declared type. The first four are checked
before any database query runs; the deserialize check happens while composing the
response.

### RPC transport

On `transport rpc` schemas the same params ride **inside the frame**, as a field
holding the JSON-object text:

```json
POST /rpc/model.Image.get
{ "id": 7, "computedParams": "{\"proxyUrl\":{\"width\":800}}" }
```

`get` frames also carry the full REST selection surface — `fields`, `include`,
and `include_fields` (snake_case on the wire, matching the list frame) — so a
projected, relation-including, parameterized read is one frame:

```json
POST /rpc/model.Image.get
{
  "id": 7,
  "fields": ["id", "proxyUrl"],
  "include": ["album"],
  "include_fields": { "album": ["id"] },
  "computedParams": "{\"proxyUrl\":{\"width\":800}}"
}
```

`model.<X>.list` frames carry the same fields, and each frame in a
`POST /rpc/batch` envelope carries its own — selection and params are applied
per-frame, order preserved. Old frames without these keys keep working
unchanged, and validation is byte-for-byte the same code path the REST query
parameters go through: an unknown field name, an orphan `include_fields`
relation, or `computedParams` naming a field excluded by `fields` are all
rejected identically on both transports. Because the frame bytes are the
signed canonical body, everything in-frame is covered by request signing
automatically.

Where `computedParams` does **not** reach, the resolver receives `None`:
relation-included records, every non-read path (create/update/delete), and
procedure outputs. It applies to the request's root model only.

## Generated clients

Computed fields appear in generated response types for Rust, Dart, and
TypeScript, and are excluded from create/update inputs, `Where` builders, and
sort enums in all three.

Every client accepts `computedParams` on `get`/`list` as a **typed, generated
per-model class** — one optional property per parameterized computed field, typed
as the declared params `type`. The parameter only exists on models that declare
at least one `@computed(params: …)` field; passing params to any other model is
a compile error in all three languages, not a runtime 422.

```dart
final image = await client.images.get(
  7,
  computedParams: ImageComputedParams(proxyUrl: ProxyParams(width: 800)),
);

// Or through the generated fluent builder — the same convention every
// generated Dart data class has:
final params = ImageComputedParamsBuilder()
    .proxyUrl(ProxyParams(width: 800))
    .build();
```

Like every generated Dart builder, `ImageComputedParamsBuilder` is expanded by
`build_runner` from a `@CratestackBuilder(...)` annotation rather than emitted
inline — see [Dart client generation: the `--run-build-runner`
flag](/guides/dart-client-generation#the-run-build-runner-flag) for what that
means for the `default` preset specifically.

The Dart surface covers both presets and both transports — the plain APIs, the
riverpod `@riverpod` convenience providers (the params class has value equality,
so provider caching keys correctly), and the RPC client mode.

```typescript
const image = await client.images.get(7, {
  computedParams: { proxyUrl: { width: 800 } } satisfies ImageComputedParams,
});
```

TypeScript's gate is the type system itself: the shared query types are generic
(`CratestackFetchQuery<TComputedParams = never>`), so `computedParams` is
unassignable on models without parameterized computed fields. swr cache keys
incorporate the params, so differently-parameterized reads never collide.

```rust
let params = ImageComputedParams::builder()
    .proxyUrl(Some(ProxyParams { width: Some(800), ..Default::default() }))
    .build();
let image = client.images().get(7, Some(&params), &[]).await?;
```

`<Model>ComputedParams` carries the same generated typestate builder every other
generated object has; a plain struct literal with `..Default::default()` works
too. The Rust client (both `include_client_schema!` and the server's embedded
self-client) exposes the struct on REST and RPC calls.

### Projected reads

Selection rides a separate client surface from the full-record `get`, on both
transports: the Rust client's `get_view<P: ProjectionDecoder>(id, projection)`
(now with an RPC twin) decodes a projected payload, and TypeScript's RPC `get`
takes `fields`/`include`/`includeFields` on its per-model options bag — the same
shape TS REST has always had. `get_view` carries no `computedParams` (matching
REST's `get_view`), so through the generated Rust surfaces you choose per call:
projection (`get_view`) or params (`get`, full record). The **wire** composes
both — TypeScript's options bag can send `fields` and `computedParams`
together, and a hand-built `RpcGetInput` can too.

## Rules enforced at parse time

`cratestack check` rejects all of these, with a span pointing at the offending
declaration:

- `@computed` on anything other than a `type` or `model` field — not on mixins,
  views, or the `auth` block, all of which lack a response-composition step.
- `@computed` combined with **any** other field attribute. A computed field is
  never stored or accepted as input, so `@id`, `@default`, `@unique`, `@readonly`,
  `@relation`, and validators would all be dead text on it.
- A computed field typed as a `model`, or as a `type` that itself contains
  computed fields — a resolver's return value is serialized as-is, so nested
  computed fields inside it would never be resolved.
- A computed-bearing `type` or `model` used as a **procedure argument**, directly
  or through a nested field. The client-side shape includes computed fields and
  the server-side shape does not, so such an input would silently lose data.
- A computed field named in `@@id`, `@@unique`, or `@@index`. Computed fields are
  never persisted, so a constraint over one could not be enforced by the database.
- `@stream` procedures whose item type is computed-bearing — per-item resolution
  inside the incremental encoder is not implemented.
- Two computed fields whose resolver method names would collide after
  snake-casing (`Image.setUrl` and `ImageSet.url` both yield
  `resolve_image_set_url`).
- An attribute argument list separated from its attribute by whitespace —
  `@computed (params: ProxyParams?)` is an error naming the attached spelling,
  not a silently bare `@computed`. (This applies to every field attribute, e.g.
  `@default (5)` too.)

`include_embedded_schema!` rejects any schema containing a computed field at
macro-expansion time. The embedded backend is synchronous and has no response
boundary at which a resolver could run; use `include_server_schema!` or
`include_client_schema!` for such a schema.

## Limitations

- Event and change-stream payloads never carry computed fields.
- `@stream` procedures cannot return computed-bearing items.
- `computedParams` applies to the request's root model only; relation-included
  records, write-path responses, and procedure outputs resolve with `None`.
- The Rust client's RPC `get_view` carries no `computedParams`, matching REST's
  `get_view`; the Dart RPC client has no projection surface yet (for `list`
  either); swr's RPC `get` cache key does not incorporate `fields`.
- Computed fields cannot be redacted through `@pii` / `@sensitive`, since
  `@computed` cannot be combined with another attribute. A resolver must not
  return data that requires audit-log redaction.
