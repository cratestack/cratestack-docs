# ADR 0002: Optional MCP Operator Surface

## Status

Proposed

## Date

2026-04-26

## Context

CrateStack v0 is designed as a Rust-native, schema-first framework layer that generates:

* a SQLx-backed ORM
* REST CRUD endpoints
* custom procedure endpoints
* authorization enforcement
* codec and envelope based REST body handling

The primary application API remains HTTP REST and must support CBOR/COSE without assuming JSON.

However, CrateStack can also provide value to AI-native systems by exposing selected schema capabilities through the Model Context Protocol (MCP). MCP-compatible clients can discover resources and tools from an MCP server. This makes it possible for agents to inspect allowed application data and invoke selected business procedures through a standardized interface.

There is an important tension:

* CrateStack's primary API direction is REST-only, no RPC.
* CrateStack's primary transport direction avoids JSON assumptions.
* MCP itself is a separate protocol surface and is JSON-RPC based.

Therefore MCP must be treated as an optional agent-facing operator, not as CrateStack's primary application API and not as a replacement for REST.

## Decision

CrateStack will support an optional MCP operator surface.

The MCP operator will be generated from the `.cstack` schema and will expose selected resources and tools to MCP-compatible clients.

The MCP operator is explicitly separate from the primary REST API.

CrateStack's primary application API remains:

```text
HTTP REST + CoolCodec + optional CoolEnvelope
```

The MCP operator is:

```text
MCP protocol adapter + CrateStack permissions + selected schema exposure
```

MCP support must be opt-in.

MCP support must not pull MCP dependencies into CrateStack core.

MCP support must not require JSON support in the REST codec layer.

MCP exposure must never bypass CrateStack permissions.

## Terminology

## MCP Resource

An MCP resource is a read-only data item exposed by the server for client context.

In CrateStack, MCP resources may be generated from:

* schema metadata
* selected model collections
* selected model records
* selected read-only procedure outputs

## MCP Tool

An MCP tool is an invokable operation exposed by the server.

In CrateStack, MCP tools should primarily be generated from schema-defined procedures.

Optional CRUD-derived tools may be added later, but procedures are the preferred tool boundary.

## MCP Operator

The MCP operator is the generated server adapter that maps MCP resource and tool calls to CrateStack ORM and procedure operations while enforcing CrateStack authorization policies.

## Schema Design

MCP exposure should be explicit.

Recommended initial schema syntax:

```cstack
mcp {
  expose resources
  expose procedures
}
```

Model resource exposure:

```cstack
model Post {
  id        Int     @id @default(autoincrement())
  title     String
  published Boolean @default(false)
  authorId  Int

  @@allow("read", published || authorId == auth().id)

  @@mcp.resource("posts")
}
```

Procedure tool exposure:

```cstack
mutation procedure publishPost(args: PublishPostInput): Post
  @allow(auth().role == "admin")
  @mcp.tool(name: "publish_post")
```

Read procedure exposure:

```cstack
procedure getFeed(limit: Int?): Post[]
  @allow(auth() != null)
  @mcp.tool(name: "get_feed")
```

Alternative shorthand may be supported later:

```cstack
@mcp.tool
```

where the generated tool name is derived from the procedure name.

## Exposure Defaults

MCP exposure must be default-off.

A model, procedure, or resource is not exposed to MCP unless explicitly annotated or included through a clear MCP block directive.

Recommended v0 default:

```text
No @mcp annotation means not exposed through MCP.
```

This is separate from authorization.

An operation must be both:

1. exposed through MCP, and
2. authorized by CrateStack permissions.

## Permission Model

MCP must not bypass permissions.

### MCP Resource Permission

MCP resources derived from model data must enforce model read policies.

Example:

```cstack
@@allow("read", published || authorId == auth().id)
```

An MCP resource read for posts must apply the same policy as REST and ORM reads.

### MCP Tool Permission

MCP tools derived from procedures must enforce procedure-level `@allow` before invoking the procedure implementation.

Example:

```cstack
mutation procedure publishPost(args: PublishPostInput): Post
  @allow(auth().role == "admin")
  @mcp.tool(name: "publish_post")
```

The MCP tool call must check the procedure permission before calling `publish_post`.

### Procedure Internal Permissions

Procedure implementations still use normal policy-protected ORM APIs.

No system bypass is introduced for MCP.

The v0 rule remains:

```text
No as_system.
No policy bypass.
```

## Generated Surface

When MCP support is enabled, the macro may generate:

```rust
cratestack_schema::mcp::server(cool)
cratestack_schema::mcp::resources(cool)
cratestack_schema::mcp::tools(cool)
```

Possible application setup:

```rust
let cool = cratestack_schema::Cratestack::builder(pool)
    .codec(cratestack_codec_cbor::CborCodec::default())
    .procedures(AppProcedures)
    .build();

let rest = cratestack_schema::routes(cool.clone());
let mcp = cratestack_schema::mcp::server(cool.clone());
```

The exact transport binding is deferred. The important architectural decision is that MCP is generated as a separate optional adapter.

## MCP Resource Mapping

For a model annotated as:

```cstack
@@mcp.resource("posts")
```

CrateStack may expose resources such as:

```text
cool://schema/models/Post
cool://models/posts
cool://models/posts/{id}
```

Recommended v0 resource set:

1. Schema metadata resources.
2. Record-by-id resources for explicitly exposed models.
3. Optional collection resources with limit enforcement.

Collection resources must have conservative limits to avoid accidental large data exposure.

Example resource behavior:

```text
Resource: cool://models/posts/123
Operation: read Post id=123 through generated ORM
Permission: model read policy applies
```

## MCP Tool Mapping

For a procedure annotated as:

```cstack
@mcp.tool(name: "publish_post")
```

CrateStack exposes an MCP tool named:

```text
publish_post
```

Tool input schema is derived from the procedure input type.

Tool result schema is derived from the procedure return type.

Tool execution path:

```text
MCP tool call
  -> deserialize tool arguments according to MCP protocol
  -> construct CoolContext
  -> evaluate procedure @allow/@deny
  -> run delegated DB-backed `@authorize(...)` checks if present
  -> call generated procedure wrapper
  -> procedure implementation runs
  -> ORM calls remain policy-protected
  -> return MCP tool result
```

## Authentication and Context

MCP does not replace CrateStack authentication delegation.

The MCP integration must provide a way to construct `CoolContext` from the MCP session/request.

Potential context sources:

* OAuth/JWT claims supplied by the MCP transport layer
* server-side session identity
* local trusted identity for stdio deployments
* explicit anonymous context

The MCP adapter must make the auth source explicit.

There must be no silent assumption that MCP clients are trusted.

## Transport Considerations

CrateStack REST transport remains codec/envelope based and may use CBOR/COSE.

MCP transport is separate.

MCP may require JSON-RPC messages. This must not contaminate the REST codec architecture.

Therefore:

* `cratestack-codec-json` remains optional for REST.
* MCP support may depend on JSON internally as required by the MCP protocol.
* This JSON dependency must live in `cratestack-mcp`, not in `cratestack-core` or REST codec crates.

## Crate Layout

Add an optional crate:

```text
cratestack-mcp/
  // MCP operator integration
  // generated resource/tool mapping helpers
  // MCP server adapter
```

Root feature:

```toml
[features]
mcp = ["dep:cratestack-mcp"]
```

MCP-related dependencies must be isolated to `cratestack-mcp`.

## Schema Compiler Changes

The parser and semantic analyzer must support:

* `mcp` configuration block
* `@@mcp.resource(...)` model attribute
* `@mcp.tool(...)` procedure attribute

The IR should record:

```rust
pub struct McpConfig {
    pub enabled: bool,
    pub expose_resources: bool,
    pub expose_procedures: bool,
}

pub struct ModelMcpExposure {
    pub resource_name: Option<String>,
}

pub struct ProcedureMcpExposure {
    pub tool_name: Option<String>,
}
```

Exact structures may differ, but MCP exposure must be represented explicitly in the IR.

## Security Requirements

1. MCP exposure is opt-in.
2. MCP resource reads enforce model read policies.
3. MCP tools enforce procedure permissions.
4. MCP tools do not bypass model policies inside procedure implementations.
5. No `as_system` is introduced for MCP.
6. MCP collection resources must have strict default limits.
7. MCP resource and tool descriptions must not leak sensitive schema details unless explicitly exposed.
8. MCP must have an explicit auth/context extraction strategy.
9. Local stdio MCP deployments must be treated carefully and not assumed safe by default.
10. Generated MCP tool names must avoid collisions.
11. Generated MCP resource URIs must avoid exposing internal database names unless explicitly configured.
12. Dangerous procedures should require explicit `@mcp.tool` annotation.

## Consequences

## Positive Consequences

* AI agents can discover and use CrateStack-backed capabilities automatically.
* Procedures become reusable across REST, local Rust calls, and MCP tools.
* Model read policies also protect MCP resources.
* MCP support does not disrupt the REST-first architecture.
* JSON remains out of the core REST codec layer.
* MCP dependencies stay isolated.
* CrateStack can support agent workflows without making RPC the primary product API.

## Negative Consequences

* MCP introduces a second protocol surface.
* MCP is JSON-RPC based, which conflicts philosophically with the primary no-RPC/no-JSON direction.
* Additional security review is required.
* MCP tool exposure can create dangerous agent-accessible operations if annotations are too broad.
* Generated schema metadata could leak sensitive model structure if exposed carelessly.
* MCP clients may behave differently, requiring compatibility testing.

## Alternatives Considered

## Alternative 1: Do Not Support MCP

Rejected because MCP is valuable for agent-facing integration and can be generated from CrateStack's schema and procedure metadata.

## Alternative 2: Treat MCP as the Primary API

Rejected because CrateStack's primary API is REST with codec/envelope support. MCP is a separate agent-facing surface.

## Alternative 3: Automatically Expose All Procedures as MCP Tools

Rejected because this creates a high risk of accidental exposure. MCP tools must be explicit and default-off.

## Alternative 4: Automatically Expose All Models as MCP Resources

Rejected because this may leak data and schema structure. Model MCP resources must be explicit and policy-protected.

## Alternative 5: Reuse REST Routes for MCP

Rejected because MCP has its own discovery and invocation semantics. It should be implemented as a separate adapter over the same CrateStack ORM/procedure layer, not as a wrapper over REST endpoints.

## Decision Drivers

1. Preserve REST-first architecture.
2. Preserve CBOR/COSE primary API support.
3. Enable agent-native integrations.
4. Keep MCP optional and isolated.
5. Reuse procedures as the safest tool boundary.
6. Enforce default-deny permissions.
7. Avoid accidental data/tool exposure.
8. Avoid contaminating core with MCP-specific JSON-RPC dependencies.

## Follow-Up Work

1. Select MCP Rust SDK or decide to implement protocol bindings directly.
2. Define exact `.cstack` MCP syntax.
3. Define generated MCP resource URI scheme.
4. Define MCP tool naming rules.
5. Define MCP context extraction strategy.
6. Define collection resource limits.
7. Add MCP section to the PRD.
8. Add MCP dependencies to the dependency decision log.
9. Add MCP security test plan.
10. Add compatibility tests with at least one MCP client.

## Final Decision Statement

CrateStack will support MCP as an optional generated operator surface that exposes explicitly annotated schema resources and procedures as MCP resources and tools. This surface is separate from the primary REST API, must not bypass CrateStack permissions, must remain default-off, and must isolate MCP's JSON-RPC requirements from the REST codec/envelope architecture.
