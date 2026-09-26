---
title: "MCP: tools and resources for agents"
description: Serve selected procedures as MCP tools and selected models as read-only MCP resources, over stdio or Streamable HTTP, through the same policy checks as REST and RPC.
---

# MCP: tools and resources for agents

<Note>
**Since CrateStack 0.13.0.** Before 0.13.0 there is no MCP runtime. A few behaviours changed in
0.13.1 and are marked *(since 0.13.1)* below. The design is
[ADR 0002](/internals/mcp-operator-adr); the tracking epic is
[cratestack#1033](https://github.com/cratestack/cratestack/issues/1033).
</Note>

CrateStack can serve parts of a schema to AI agents over the
[Model Context Protocol](https://modelcontextprotocol.io), revision `2026-07-28`. Procedures you
annotate become MCP **tools**. Models you annotate become read-only MCP **resources**. Every call
goes through the same generated policy checks as REST and RPC: an agent can do exactly what the
same caller could do over REST, and nothing more.

MCP is opt-in twice. You enable a Cargo feature, and you annotate each declaration you want to
expose. Nothing without an annotation reaches an agent.

## Enable it

Turn on the `mcp` feature of the facade you already use. Tools work on `cratestack-pg` and
`cratestack-api`. Resources need `cratestack-pg`. `cratestack-sqlite` has no `mcp` feature (the
embedded role enforces no policy), and `cratestack-client` serves nothing.

```toml
cratestack = { package = "cratestack-pg", version = "0.13", features = ["mcp"] }
```

Then declare what to expose:

```cstack
mcp {
  name = "blog"
  expose = [tools, resources]
}

model Post {
  id Int @id
  authorId String
  title String
  published Boolean

  @@allow("read", published || authorId == auth().id)
  @@mcp(resource: "posts")
}

procedure recentPosts(limit: Int): Post[]
  @allow(auth() != null)
  @mcp(tool: "recent_posts", description: "The newest posts you may read.")

mutation procedure publishPost(id: Int): Post
  @allow(auth() != null && auth().role == "editor")
  @mcp(tool: "publish_post", description: "Publish a draft post. Editors only.")
```

A complete, runnable version of this is the
[`mcp-operator` example](https://github.com/cratestack/cratestack/tree/main/examples/mcp-operator).

## The schema rules

- **`mcp { }`** takes `expose = [tools]`, `[resources]` or both. `name` is required when
  `resources` is exposed, and refused otherwise.
- **`name`** is the host of every resource URI (`cratestack://blog/...`), so it is a DNS label:
  - lowercase letters, digits and `-`, 1 to 63 characters, not starting or ending with `-`;
  - it may not have `--` as its 3rd and 4th characters (IDNA's reserved form, as in `xn--`);
  - it must contain a letter, so `127` is refused.
- **`@mcp(tool: "name")`** exposes a procedure. A bare `@mcp(tool)` uses the procedure's own name.
  `description:` is optional. The procedure must have an `@allow`; `@deny` alone is not enough.
- **`@@mcp(resource: "segment")`** exposes a model. It must have a read allow, `@@allow("read", ...)`
  or `@@allow("all", ...)`. An optional `max_page_size:` (1 to 200) lowers the page-size cap.

Every malformed or contradictory MCP declaration is a compile error, never silently ignored. Until
the `mcp` feature is on, any MCP declaration is a compile error that tells you to enable it.

Some procedures can't be tools, and saying `@mcp(tool)` on them is a compile error too:
`@stream` procedures (a tool result is one response), and procedures whose input or output reaches a
type with no faithful JSON Schema: `Json`, `FindMany`, `Vector`, `Geography` and `Geometry`. A
`Decimal` needs the schema's `decimal = RustDecimal | BigDecimal` argument.

## Serve it over stdio

The schema macro generates `cratestack_schema::mcp`. Its `tools(db, registry, resolvers)` value is
the tool table. Over stdio you name the caller explicitly. There is no default identity, and an
anonymous context is refused *(since 0.13.1)*: `StdioServer::new` returns
`StdioConfigError::AnonymousContext` for a context that isn't authenticated, the same rule the HTTP
guard applies to your `AuthProvider`. On 0.13.0 it accepted one and served every call as nobody.

```rust
let ctx = cratestack::SystemContext::for_service("support-agent").into_context();
cratestack::mcp::StdioServer::new(cratestack_schema::mcp::tools(db, registry, resolvers), ctx)?
    .serve()
    .await?;
```

Send `tracing` to stderr, because stdout carries only MCP messages:
`tracing_subscriber::fmt().with_writer(std::io::stderr)`. The server exits when stdin closes.

## Serve it over Streamable HTTP

Mount it on your axum router, behind the same `AuthProvider` your REST routes use:

```rust
let resource = ProtectedResource::new("https://api.example.com/mcp", ["https://auth.example.com"]);
let mcp = StreamableHttpServer::builder(tools, auth_provider, ["https://app.example.com"], resource)
    .build()?;
let app = Router::new()
    .nest_service("/mcp", mcp.service())
    .merge(mcp.metadata_router()); // RFC 9728 metadata, at the root
```

The allowed browser origins and the provider are required. An empty origins list is refused.

Before any MCP handling:

| Request | Answer |
|---|---|
| A foreign `Origin` | 403 |
| `GET` or `DELETE` | 405 |
| A token in the query string (`?access_token=`) | 400 `invalid_request` |
| Two `Authorization` headers, or `Bearer` with no token | 400 `invalid_request` |
| No token, or a token your provider rejects | 401 with `WWW-Authenticate: Bearer resource_metadata="…"` |
| A body over 4 MiB | 413 |

The token is removed from the request once your provider has run. Every call then runs under the
`CratestackContext` your provider built.

<Warning>
**Your `AuthProvider` must check the token's audience** against the resource identifier. MCP
requires it, and CrateStack ships no generic OAuth provider. The example's `src/token.rs` shows an
audience check.
</Warning>

## What a tool call goes through

1. The tool name is looked up. An unknown name is JSON-RPC `-32602`.
2. The arguments are decoded into the procedure's `Args`. A failure is an `isError` result that
   names the field.
3. If you passed an `OpExecutor` with `with_executor`, L3 admission runs: rate limiting, then
   idempotency. An idempotency key travels in `_meta["dev.cratestack/idempotencyKey"]`; without
   one, nothing is reserved. A failing rate-limit store follows the `StoreErrorPolicy` you pass to
   `with_store_error_policy`, the same type `RateLimitLayer` uses on HTTP. The budget is per
   caller and per transport: a caller's MCP calls and its REST calls are counted separately.
   *(since 0.13.1)* The MCP key holds a SHA-256 of the caller's id, not the id itself. After
   upgrading from 0.13.0 with a shared store, MCP idempotency records written by 0.13.0 no longer
   replay and MCP rate-limit buckets start fresh.
4. The procedure's generated `invoke_with_db` runs `@allow` / `@deny` and any `@authorize(...)`,
   then your implementation. Its ORM calls carry `@@allow` in their SQL.

Errors are `isError: true` results whose text is REST's error envelope (`code`, `message`), so MCP
reveals nothing REST doesn't.

## Resources

A model annotated `@@mcp(resource: "posts")` is readable at:

- `cratestack://blog/posts/{id}`: one record, shaped exactly like REST's `GET /posts/{id}`.
  `@server_only` fields are absent and `@computed` fields are resolved.
- `cratestack://blog/posts{?limit,cursor}`: a page, `{"items": [...], "nextCursor": "..."}`, in
  primary-key order. `limit` defaults to 50 and is clamped, not refused, at 200 or at the model's
  `max_page_size`. Pass `nextCursor` back as `cursor`.

Reads use the caller's context, so `@@allow("read", ...)` is in the SQL. A row the caller may not
read and a row that doesn't exist both return the same `-32602` "resource not found". So do a
malformed id and an id with a raw character that isn't allowed in a URI path segment:
percent-encode those (`a%20b` reads id `a b`). The scheme is case-insensitive; the name, segment and
id are matched exactly.

## Connecting a client

The client must speak protocol `2026-07-28`. The server doesn't negotiate down, so a client that
opens with the older `initialize` handshake gets `-32022`. With the official
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) CLI, pass `--protocol-era modern`.
The `mcp-operator` example's README has Inspector commands and an `mcpServers` config for both
transports.

## Not in v1

- CRUD-derived tools. Only procedures are tools, and models are read-only resources.
- Filtering `tools/list` by the caller's authorization. Every caller sees the whole table, and each
  call is still policy-checked.
- MCP on the embedded role (`cratestack-sqlite`).
- A generic OAuth `AuthProvider`. You bring your own, and it must check the audience.
