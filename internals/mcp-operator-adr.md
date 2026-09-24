---
title: "ADR 0002: Optional MCP Operator Surface"
description: An opt-in, schema-generated Model Context Protocol server that exposes explicitly annotated procedures as MCP tools and models as MCP resources, over the same policy-enforcing call path as REST and RPC. Proposed; revised 2026-09-24.
---

# ADR 0002: Optional MCP Operator Surface

## Status

**Proposed**, revised 2026-09-24. Nothing here is implemented. There is no
`cratestack-mcp` crate. The parser accepts a bare `mcp { ... }` block
(`cratestack-parser/src/parse/mod.rs`), keeps its body as raw text lines in
`Schema.config_blocks`, and nothing validates or reads it.

The first version of this ADR (2026-04-26) was written before the RPC transport,
the layer model (ADR 0011, ADR 0014), facade disjointness (ADR 0013), the L3
`OpExecutor` (ADR 0015) and the 2026-07-28 MCP specification. This revision
restates it against the framework as it exists now. The original text is in
this file's git history.

The maintainer settled every question in the table below on 2026-09-24: D1–D4
by choosing among options, and D5, D6 and Q1–Q5 by taking the recommendation.
The ADR itself stays **Proposed** until the maintainer accepts it.

## Date

- 2026-04-26: proposed
- 2026-09-24: revised against current architecture; D1–D6 and Q1–Q5 decided

## Decisions for the maintainer

| # | Question | Recommendation | Decision |
|---|---|---|---|
| D1 | Attribute syntax: the dotted `@mcp.tool` / `@@mcp.resource`, or `@mcp(tool: ...)` / `@@mcp(resource: ...)`? | The argument form. No existing attribute has a dotted name, and the tree-sitter grammar's attribute token (`"@" IDENTIFIER`, with no dot in `IDENTIFIER`) cannot lex one. | **`@mcp(tool: ...)` / `@@mcp(resource: ...)`** (2026-09-24) |
| D2 | How does MCP dispatch relate to the L3 `OpExecutor`? | MCP goes through L3 for **admission only** (idempotency, rate limiting). Policy stays where it is enforced today. | **L3 for admission only** (2026-09-24) |
| D3 | Which facades offer the `mcp` feature? | `cratestack-pg` (tools and resources) and `cratestack-api` (tools only). | **`cratestack-pg` + `cratestack-api`** (2026-09-24) |
| D4 | Protocol implementation: `rmcp` or our own? | `rmcp` 3.4.x, the official Rust SDK. | **`rmcp` 3.4.x** (2026-09-24) |
| D5 | Is MCP exempt from the REST/RPC transport-parity rule? | Yes, explicitly. MCP exposes an opt-in subset, not the application API (§ Transport parity). | **As recommended** (2026-09-24) |
| D6 | Do CRUD-derived tools ship in v1? | No. v1 has procedures as tools and models as read-only resources. CRUD tools get their own ADR amendment. | **As recommended** (2026-09-24) |
| Q1 | stdio identity: where does the `CratestackContext` come from? | The application supplies it explicitly when it builds the stdio server. There is no default, and there is no "local means trusted" path. | **As recommended** (2026-09-24) |
| Q2 | Default tool name when `@mcp(tool)` has no `name:` argument? | The procedure name as written (`publishPost`). It already satisfies the spec's `[A-Za-z0-9_.-]{1,128}`. | **As recommended** (2026-09-24) |
| Q3 | Default and maximum page size for collection resources? | 50 by default, with a hard maximum of 200. A schema can lower the maximum but never raise it past 200. | **As recommended** (2026-09-24) |
| Q4 | Release gating between the parser slice and the runtime slice? | The macro emits `compile_error!` for any `@mcp`/`@@mcp` attribute until the runtime ships. Otherwise the attributes parse and do nothing, which is how `@no_idempotency` sat for two release cycles. | **As recommended** (2026-09-24) |
| Q5 | Should CrateStack ship a generic OAuth access-token `AuthProvider` (JWKS, RS256/ES256, `aud` and `iss` checks), or leave that to the application? | Leave it to the application for v1, and show one in the example. The existing `IdTokenVerifier` is not that provider (§ Authentication and context). | **As recommended** (2026-09-24) |

## Context

CrateStack generates, from one `.cstack` schema, a typed Rust surface for one of
three roles (server, embedded, client), published through four disjoint facades.
A server schema serves either REST (the default) or `transport rpc`. Both use the
codec layer (CBOR by default, JSON optional through `cratestack-codec-json`).

The Model Context Protocol lets an agent discover and invoke a server's
capabilities. CrateStack's schema already records everything an MCP server needs
to describe itself: procedures with typed arguments and results, models with
typed fields, and the policies that guard both. Generating an MCP surface from
that schema is cheap, and far safer than an application wiring its own MCP
server around generated code by hand.

MCP is its own protocol. It runs JSON-RPC 2.0 over stdio or over Streamable
HTTP, and its discovery and invocation model (`tools/list`, `tools/call`,
`resources/read`) matches neither REST's resource routes nor RPC's `op_id`
dispatch. So it is a third surface, not a mode of an existing one.

The original ADR framed MCP as being in tension with a "REST-only, no RPC"
direction. That direction no longer exists, because RPC shipped. What remains
true is that MCP is **agent-facing and opt-in**, not a transport for the
application API.

### Facts this revision builds on

1. **The procedure policy step is already usable without HTTP.** Every generated
   procedure has `authorize(args, ctx)`, `authorize_with_db(db, args, ctx)` and
   `invoke_with_db(db, args, ctx, f)`. These evaluate `@allow`/`@deny` and any
   delegated `@authorize(...)` check, and return an `Authorized` token that the
   implementation needs in order to run. Because the `ProcedureRegistry` method
   requires that token, calling an implementation without running its policy
   does not compile (cratestack#512). Under `db = None`, `Cratestack` is a unit
   struct, so `cratestack-api` uses the same path. ADR 0018 committed to this
   path for in-process callers.
2. **Row-level model policy lives in the SQL.** `@@allow` is compiled into the
   SQL of every read and write (`cratestack-sqlx/src/query/support/policy.rs`).
   Any caller that goes through the generated ORM gets it, whatever the
   transport.
3. **L3 admits; it does not authorize.** `cratestack-exec`'s `OpExecutor`
   performs idempotency admission (slice 1) and rate-limit admission (slice 2)
   over a transport-neutral `OpInput`. Policy is not an L3 concern today, and
   slice 3 (policy replay on streams) is not built.
4. **ADR 0015 anticipated this.** Its *Deferred* section names "`mcp` tool
   dispatch" as a trigger to revisit L3's scope. This ADR is that trigger. See
   § Relationship to ADR 0015.
5. **Procedure I/O is already serde.** Generated `Args` and output types derive
   `Serialize`/`Deserialize`, so JSON (de)serialization of tool arguments and
   results needs no new derives.
6. **No JSON Schema generator exists.** `OpDescriptor.input_ty`/`output_ty` are
   type-name strings. MCP requires a JSON Schema `inputSchema` for every tool,
   so generating these is new work.
7. **The embedded role enforces no policy.** `cratestack-rusqlite` compiles no
   `@@allow`/`@allow` checks, by design.

## Decision

CrateStack will offer an **optional MCP operator**: a generated MCP server that
exposes **explicitly annotated** procedures as MCP tools and **explicitly
annotated** models as read-only MCP resources. It reaches them through the same
generated functions the REST and RPC paths call, so it enforces the same
policies.

- **It is opt-in, twice.** A facade feature (`mcp`) must be on, *and* each
  procedure or model must be annotated. Nothing is exposed by default.
- **It never bypasses policy.** An MCP tool call runs the procedure's generated
  authorize step before the implementation. An MCP resource read goes through
  the generated ORM, so the model's read policy is part of the SQL. MCP gets no
  bypass, and no MCP-specific system context.
- **It is isolated.** MCP's dependencies (`rmcp`, `serde_json`, `schemars`) live
  in `cratestack-mcp` and behind the facade feature. They never reach
  `cratestack-core`, the codec crates or a facade built without `mcp`.

## Schema surface

The block turns MCP on for the schema and sets its scope:

```cstack
mcp {
  expose tools
  expose resources
}
```

A procedure is exposed as a tool by `@mcp(tool)`, optionally naming it:

```cstack
mutation procedure publishPost(args: PublishPostInput): Post
  @allow(auth().role == "admin")
  @mcp(tool, name: "publish_post", description: "Publish a draft post.")

procedure getFeed(args: FeedArgs): Post[]
  @allow(auth() != null)
  @mcp(tool)
```

A model is exposed as a read-only resource by `@@mcp(resource: "<segment>")`:

```cstack
model Post {
  id        Int     @id @default(autoincrement())
  title     String
  published Boolean @default(false)
  authorId  Int

  @@allow("read", published || authorId == auth().id)
  @@mcp(resource: "posts")
}
```

The original draft's `expose procedures` becomes `expose tools`, which matches
MCP's own vocabulary. (That rename is part of this revision, not a separate
decision.)

### Validation

MCP exposure changes what an agent can reach, so a malformed or contradictory
MCP annotation is a **hard error**, never silently inert. This is stricter than
the general unknown-attribute policy (#679), on purpose.

- `@mcp(...)` on a procedure must contain `tool`. `name:` must match
  `[A-Za-z0-9_.-]{1,128}`, and `description:` must be a string literal.
- `@@mcp(...)` on a model must contain `resource: "<segment>"`, and the segment
  must match `[a-z0-9-]+`. An optional `max_page_size:` must be an integer from
  1 to 200. It lowers that resource's maximum page size (Q3), and a value above
  200 is an error, not a clamp.
- An `@mcp`/`@@mcp` attribute in a schema with no `mcp { }` block is an error,
  and so is `mcp { expose tools }` with no `@mcp(tool)` anywhere.
- Two tools with the same name, or two resources with the same segment, are an
  error.
- `@@mcp(resource: ...)` on a model with no `@@allow("read", ...)` is an error.
  A resource with no read policy would be readable by anyone the transport
  admits.
- `@mcp(tool)` on a procedure with no `@allow`/`@deny` is an error, for the same
  reason.
- `@@mcp` is an error in a `db = None` schema, which has no models. More
  generally, `mcp { expose resources }` is rejected wherever resources cannot
  exist.
- In a `part of` file, `mcp { }` is rejected (#993). The attributes follow their
  declaration.

## Dispatch

The macro emits a per-schema `mcp` module next to the REST and RPC modules
(`cratestack-macros/src/include/server/mcp_module/`). It contains:

- a static table of exposed tools and resources: name, description, annotations,
  and JSON Schemas generated at compile time;
- a `match` from tool name to a call into that procedure's generated functions.

`cratestack-mcp` supplies the protocol side. It implements `rmcp`'s
`ServerHandler` over that generated table, so no hand-written `#[tool]`
functions are involved.

Tool execution path:

```text
tools/call
  -> look up the tool by name                  (unknown -> JSON-RPC -32602)
  -> deserialize arguments into the procedure's Args  (invalid -> isError result)
  -> build OpInput, OpExecutor admission       (L3: rate limit, idempotency)
  -> <procedure>::invoke_with_db(db, &args, &ctx, |authorized| impl(...))
       -> @allow / @deny, then delegated @authorize(...) checks
       -> the implementation runs; its ORM calls carry model @@allow in SQL
  -> serialize output as structuredContent + text   (policy denial -> isError)
```

Resource read path:

```text
resources/read cratestack://<schema>/<segment>/<id>
  -> parse the URI against the generated template   (unknown -> -32602)
  -> OpExecutor admission (rate limit)
  -> generated ORM get-by-id under ctx              (model @@allow in the SQL)
  -> not found or not visible -> -32602 (the two are not distinguished)
```

A row the caller may not read and a row that does not exist return the same
error. MCP must not become an oracle for existence that REST is not.

### Relationship to ADR 0015

ADR 0015 said a non-HTTP dispatch path with a real consumer should reopen its
scope. MCP over stdio is such a path. **D2 answers the reopened question
narrowly:** MCP uses L3 exactly as REST and RPC do, for admission. Policy stays
in the generated authorize step and in the SQL, because both are already
transport-neutral (facts 1 and 2). Moving them to L3 is not required to build
MCP, and building MCP does not wait for it. An amendment to ADR 0015 records
this, so its text and this ADR agree.

## Tools

- **Input schema.** A JSON Schema 2020-12 object generated at compile time from
  the procedure's `Args` type. Every `.cstack` type needs a defined mapping:
  scalars, `Decimal` (as a string, so precision is not lost), `DateTime`, enums,
  optional fields, lists and nested `type`s. This mapping is the largest single
  piece of new code in this ADR.
- **Output.** A generated `outputSchema` when the return type is an object. The
  result is sent as `structuredContent` and also as a text block.
- **Annotations.** A `procedure` gets `readOnlyHint: true`. A
  `mutation procedure` gets `readOnlyHint: false`, and `idempotentHint` taken
  from `OpDescriptor.idempotent_by_default`. Clients must treat these as
  untrusted hints, and CrateStack does not rely on them for safety.
- **Errors.** An unknown tool or a malformed request is a JSON-RPC protocol
  error. Argument validation failures, policy denials and business errors
  (`CratestackError`) are returned as `isError: true` results, so an agent can
  correct itself. Internal errors are not described beyond what the REST error
  envelope would already reveal.
- **Listing.** `tools/list` returns the static table in declaration order. The
  spec allows filtering the list by the caller's authorization; v1 does not
  filter, and says so.

## Resources

- **URI scheme.** `cratestack://<schema>/<segment>/{id}` for one record, and
  `cratestack://<schema>/<segment>` for a page of records. `<segment>` comes
  from `@@mcp(resource: ...)`, never from a table or model name, so the
  database layout is not exposed.
- **Collections** are paginated with the spec's opaque cursor. The default page
  size is 50 and the maximum is 200, or the resource's `max_page_size:` if that
  is lower (Q3). A client asking for more gets the maximum, not an error.
- **Schema metadata** is exposed only for annotated models and tools, never for
  the whole schema.
- `ttlMs` and `cacheScope` are required on every result by 2026-07-28. Resource
  reads return `cacheScope` private to the caller.

## Transports

Both transports follow the 2026-07-28 specification, in which every request is
self-contained. There is no `initialize` handshake and no `Mcp-Session-Id`.
`rmcp` 3.4.1 supports this revision, but its `ProtocolVersion::LATEST` still
points to `2025-11-25`, so `cratestack-mcp` pins the version itself. The
deprecated HTTP+SSE transport is not offered.

- **stdio.** Newline-delimited JSON-RPC. Only MCP messages go to stdout;
  `tracing` output goes to stderr. The server exits when stdin closes.
- **Streamable HTTP.** A tower service mounted on the application's axum
  router, for example `.nest_service("/mcp", ...)`. It answers `GET`/`DELETE`
  with 405 and rejects mismatched `MCP-Protocol-Version` / `Mcp-Method` /
  `Mcp-Name` headers. It requires an explicit allowed-origins list: `rmcp`
  disables Origin validation when that list is empty, so `cratestack-mcp`
  refuses to build an HTTP service without one.

## Authentication and context

Neither transport assumes the caller is trusted. Each builds a
`CratestackContext` explicitly.

- **HTTP.** The MCP endpoint authenticates through the application's own
  `AuthProvider` (`cratestack-core/src/context.rs`), the same extension point
  its REST and RPC routers use. `rmcp`'s Streamable HTTP service carries the
  request's `http::request::Parts` into the handler, so the provider sees the
  real method, path and headers, and no second auth mechanism is involved.
  `cratestack-mcp` adds the parts the MCP authorization spec requires of an
  OAuth 2.1 resource server and `rmcp` does not provide on the server side:
  - a 401 with `WWW-Authenticate` naming `resource_metadata`;
  - Protected Resource Metadata (RFC 9728) at
    `/.well-known/oauth-protected-resource`, listing the configured
    authorization server(s);
  - no passing of the token on to any other service.

  Audience validation is the provider's job, and the spec requires it. The
  bundled `IdTokenVerifier` checks audience, but it verifies CrateStack's own
  Ed25519 SD-JWT id-tokens with `cnf.kid` key binding, not arbitrary OAuth access
  tokens from a third-party authorization server (Q5).
- **stdio.** The spec says credentials come from the environment, not from an
  OAuth flow. `cratestack-mcp` requires the application to pass a context when
  it builds the stdio server (Q1): for example
  `CratestackContext::authenticated(...)` built from a verified token in the
  environment, or `SystemContext::for_service(...)` for a deliberate service
  identity. There is no default identity.

## Crate layout and layering

- **`cratestack-mcp`**, at **L4 (Bindings)** in `docs/adr/layers.toml`, next to
  `cratestack-axum`. It is one wire protocol's encode, decode and routing. It
  depends on `cratestack-core`, `cratestack-exec` and `rmcp`, and has no
  database dependency. Access to the database goes through the per-schema
  generated module compiled into the consuming crate, as with REST and RPC.
- **Facade features (D3).** `cratestack-pg` gets `mcp = ["dep:cratestack-mcp"]`
  (tools and resources). `cratestack-api` gets the same feature (tools only).
  `cratestack-sqlite` and `cratestack-client` do not get it. The embedded role
  enforces no policy (fact 7), so an MCP surface there could not keep this ADR's
  central promise. The client facade serves nothing.
- **Disjointness (ADR 0013).** With `mcp` off, a facade's dependency graph is
  unchanged. CI's `facade-disjointness` job gains a `cargo tree` assertion that
  `rmcp` is absent from every facade's default graph.
- **Dependencies (D4).** `rmcp` 3.4.x is Apache-2.0 (already allowed in
  `deny.toml`), has an MSRV of 1.88 (the workspace pins 1.98) and supports the
  2026-07-28 spec. Its `server` feature always pulls in `schemars`. We accept
  that, but still generate our own schemas from the `.cstack` IR rather than
  deriving `JsonSchema` on generated types, because only the IR knows
  CrateStack's type semantics (`Decimal`-as-string, `@computed`, relations).

## Transport parity

CrateStack's rule that REST and RPC ship together (CLAUDE.md, "Transport
parity") exists because both carry the **application API**. MCP carries an
**opt-in subset for agents**. **Decided (D5):** MCP is exempt. A new
request-surface feature ships on REST and RPC, and reaches MCP only when someone
deliberately extends MCP. The exemption must be written into the parity rule
itself, so it doesn't read as an oversight.

## Security requirements

1. Exposure is opt-in at both the facade (feature) and the declaration
   (attribute).
2. Resource reads enforce model read policy, through the generated ORM.
3. Tool calls run the procedure's generated authorize step before the
   implementation.
4. Procedure implementations keep using the policy-enforcing ORM; MCP adds no
   bypass.
5. A resource or tool with no policy is a compile error, not an open door.
6. Collection resources have a strict default and a maximum page size.
7. Descriptions and schema metadata cover only exposed declarations.
8. Every transport builds its context explicitly. stdio has no implicit identity.
9. HTTP authenticates through an audience-validating `AuthProvider`, never
   passes the token through, and requires an allowed-origins list.
10. Tool names and resource segments are checked for collisions at compile time.
11. Resource URIs use author-chosen segments, never table names.
12. Not visible and not found are indistinguishable.
13. MCP calls pass the same L3 rate-limit admission as REST and RPC.

## Consequences

### Positive

- Agents can discover and call CrateStack capabilities, typed and
  policy-enforced, without hand-written glue.
- Procedures become reusable across REST, RPC, in-process calls and MCP through
  one authorize step.
- The JSON Schema generator this needs is reusable, for example for OpenAPI,
  which also does not exist today.
- MCP dependencies stay out of every build that doesn't enable the feature.

### Negative

- A third protocol surface to maintain and secure.
- `.cstack` → JSON Schema is new code with no precedent in the workspace.
- `rmcp` is on a fast release cadence (3.x) and the spec had a breaking revision
  on 2026-07-28, so upgrades will need attention.
- `rmcp` brings `schemars` into MCP-enabled builds even though we generate
  schemas ourselves.
- Agents behave differently from each other, so compatibility testing against
  at least one real client is required, not optional.

## Alternatives considered

1. **Do not support MCP.** Rejected: the schema already has what MCP needs, and
   hand-built MCP servers around generated code are where policy bypasses
   happen.
2. **MCP as the primary API.** Rejected: MCP is agent-facing; REST and RPC stay
   the application API.
3. **Expose all procedures or all models automatically.** Rejected: exposure is
   default-off and per declaration.
4. **Wrap REST routes.** Rejected: MCP has its own discovery and invocation
   model, and routing through HTTP handlers would add a second decode step and
   an HTTP dependency to stdio.
5. **Dotted attributes (`@mcp.tool`).** Rejected in D1: a new lexical shape and a
   blocking tree-sitter grammar change, for no semantic gain.
6. **Wait for L3 to own policy before building MCP.** Rejected in D2: policy is
   already transport-neutral where it lives.
7. **Offer MCP on the embedded facade.** Rejected in D3: no policy enforcement to
   rely on.
8. **Write the protocol layer ourselves.** Rejected in D4: `rmcp` is the official
   SDK, supports the current spec and takes a dynamic tool list.

## Implementation plan

Each phase lands as its own pull request (or set of PRs). None is merged into a
release while `@mcp` still parses and does nothing (Q4).

| Phase | Scope | Decisive test |
|---|---|---|
| 0 | This revision, the ADR 0015 amendment, the tracking epic | — |
| 1 | Parser and IR: the `mcp { }` block with typed settings, `@mcp(...)` / `@@mcp(...)`, the § Validation rules, LSP completions and hover, and the Q4 `compile_error!` gate | Each validation rule has a failing-schema test that fails when the rule is removed; a schema using `@mcp` fails to compile until phase 3 removes the gate |
| 2 | `.cstack` → JSON Schema at compile time | serde's actual output for sample values validates against the generated schema |
| 3 | `cratestack-mcp` and the generated `mcp` module: tools over stdio through L3 admission and `invoke_with_db`; the Q4 gate is removed; the D5 exemption is written into the transport-parity rule | A call denied by `@allow` returns `isError`; loosening that `@allow` to `@allow(true)` flips the test (removing it is a compile error since phase 1) |
| 4 | Streamable HTTP: `AuthProvider` integration, RFC 9728 metadata, Origin enforcement | A token for another audience gets 401; a foreign Origin gets 403 |
| 5 | Resources: by id, paged collections, schema metadata | A row hidden by `@@allow` is invisible over MCP exactly as over REST (Postgres-backed test) |
| 6 | Example service, a conformance run with a real MCP client, docs page, `cratestack-skills` coverage | — |
