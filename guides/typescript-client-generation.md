---
title: TypeScript client generation
description: Generate a typed TypeScript package — REST or RPC, fetch client plus TanStack Query hooks — from a `.cstack` schema with `cratestack generate-typescript`, and compare the same call across TypeScript, Dart, and Rust clients.
---

# TypeScript client generation

`cratestack generate-typescript` renders a complete, publishable TypeScript package from a parsed `.cstack` schema: typed models, a fetch-based client, and TanStack Query hooks. It's implemented by `cratestack-client-typescript` and uses the same schema-first approach as the Rust and Dart client generators — there is no OpenAPI/Swagger document in the middle, the `.cstack` file is the only source of truth.

This guide covers generating the package, what it contains, how to use it against both transport styles, and how the same call looks across TypeScript, Dart, and Rust.

## Generate the package

### From the CLI

```bash
cargo run -p cratestack-cli -- generate-typescript \
  --schema crates/cratestack-pg/tests/fixtures/blog.cstack \
  --out packages/blog-client \
  --package-name @example/blog-client \
  --base-path /cstack
```

`generate-ts` works as a shorter alias for the same subcommand. Once the CLI binary is installed, drop the `cargo run -p cratestack-cli --` prefix and call `cratestack generate-typescript ...` directly.

| Flag | Required | Default | Notes |
|---|---|---|---|
| `--schema` | yes | — | path to the `.cstack` file |
| `--out` | yes | — | output directory for the generated package |
| `--package-name` | no | `cratestack-client` | written into the generated `package.json`; also derives the client class name (see below) |
| `--base-path` | no | `/api` | default API base path baked into the runtime |
| `--template-dir` | no | none | override individual `.j2` templates; anything not overridden falls back to the bundled default |

The client class name is derived from `--package-name`: non-alphanumeric characters become spaces, the result is PascalCased, and `Client` is appended. `@example/blog-client` becomes `ExampleBlogClientClient`. Pick a package name with that in mind if the resulting class name matters to you.

### From Rust

Call the generator directly when you're wiring codegen into your own build script, a CI step, or Studio-adjacent tooling, instead of shelling out to the CLI:

```rust
use cratestack_client_typescript::{TypeScriptGeneratorConfig, generate_package};

let schema = cratestack_parser::parse_schema_file("schema.cstack")?;
let package = generate_package(&schema, &TypeScriptGeneratorConfig {
    package_name: "@example/blog-client".to_owned(),
    base_path: "/cstack".to_owned(),
    template_dir: None,
})?;

for file in package.files {
    let path = out_dir.join(&file.file_name);
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(path, &file.contents)?;
}
```

`generate_package` is pure — it takes a parsed `Schema` and a config, and returns an in-memory file list. Writing those files to disk is the caller's job, exactly like `handle_generate_typescript` does inside the CLI.

### Picking REST or RPC

There's no flag for this. The generator reads `schema.transport` off the parsed `.cstack` file and switches templates accordingly — REST is the default, and a schema opts into RPC with the `transport rpc` directive at the top of the file:

```cstack
transport rpc

datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

auth Operator {
  id Int
}

model Widget {
  id Int @id
  name String
  weight Int?

  @@allow("read", auth() != null)
  @@allow("create", auth() != null)
  @@allow("update", auth() != null)
  @@allow("delete", auth() != null)
}

procedure echoName(name: String): String
  @allow(auth() != null)
```

See the [RPC transport](/guides/rpc-transport) guide for the full design. The CLI invocation is identical either way — only the schema changes:

```bash
cargo run -p cratestack-cli -- generate-typescript \
  --schema schemas/widget_rpc.cstack \
  --out packages/widget-client \
  --package-name @example/widget-client \
  --base-path /api
```

### Regenerating after schema changes

The generated package is build output, not hand-edited source — treat it the same way you'd treat a `dist/` folder. Whenever the `.cstack` schema changes (or the generator/templates change), re-run the same `generate-typescript` command against the same `--out` directory. There's no incremental/merge step; the generator overwrites the package's `src/` files wholesale.

## Build the generated package

The generator emits an npm package skeleton, not compiled JS — build it before consuming it:

```bash
cd packages/blog-client
npm install
npm run build   # runs `tsc -p tsconfig.json`, emits dist/
```

`@tanstack/react-query` is listed as a `peerDependency`, so `npm install` won't pull it in on its own — only install it if you're going to import the generated React Query hooks.

## Package layout

Every generated package ships `package.json`, `tsconfig.json`, `README.md`, and a `src/index.ts` barrel that re-exports everything. What's under `src/` beyond that depends on the schema's transport:

| File | REST | RPC | Contains |
|---|---|---|---|
| `src/models.ts` | ✓ | ✓ | model/input interfaces, enums, `Page<T>` |
| `src/runtime.ts` | ✓ | ✓ | `CratestackRuntime` (REST) or `CratestackRpcRuntime` (RPC) — the one place HTTP/serialization logic actually lives |
| `src/client.ts` | ✓ | ✓ | per-model API classes (`list`/`get`/`create`/`update`/`delete`) and `ProceduresApi`, all thin wrappers over the runtime |
| `src/queries.ts` | ✓ | — | `CratestackFetchQuery` / `toSearchQuery` — REST-only, since RPC dispatches by op ID instead of query-string projection params |
| `src/react-query.ts` | ✓ | ✓ | `useXListQuery`, `useCreateXMutation`, etc. — TanStack Query hooks over the client |

The per-model classes in `client.ts` aren't hardcoded fetch calls duplicated per endpoint — each method is a few lines that delegates into the single shared runtime class, so the actual request/serialization/error-handling logic exists once regardless of how many models the schema declares.

## Using the REST client

Examples below use the `blog.cstack` fixture (`crates/cratestack-pg/tests/fixtures/blog.cstack`): a `Post` model with full CRUD, a `Session` model with `@@paged`, a query procedure `getFeed`, and a mutation procedure `publishPost`.

### Construct the client

```ts
import { ExampleBlogClientClient } from "@example/blog-client";

const client = new ExampleBlogClientClient("https://api.example.com", {
  basePath: "/cstack",
  headers: async () => ({
    authorization: `Bearer ${await tokenStore.getAccessToken()}`,
    "x-request-id": crypto.randomUUID(),
  }),
});
```

`headers` accepts a static object or an async function, evaluated on every request — useful for token refresh. Per-call headers merge on top:

```ts
await client.posts.create(input, {
  headers: { "idempotency-key": idempotencyKey },
});
```

### CRUD

```ts
const posts = await client.posts.list({
  query: { fields: ["id", "title"], sort: ["-id"], limit: 20 },
});

const post = await client.posts.get(1, {
  query: { fields: ["id", "title"], include: ["author"] },
});

const created = await client.posts.create({
  id: 3,
  title: "Created Post",
  subtitle: "created",
  published: true,
  authorId: 1,
});

const updated = await client.posts.update(1, {
  title: "Updated Post",
  published: false,
});

await client.posts.delete(1);
```

`Session` opts into `@@paged`, so its `list` returns `Page<Session>` instead of `Session[]` — the shape (`{ items, pageInfo }`) is generated per model based on that schema attribute, not something you opt into on the client.

### Procedures

```ts
const feed = await client.procedures.getFeed({ limit: 10 });

const published = await client.procedures.publishPost({
  args: { postId: 1 },
});
```

Procedure argument interfaces are generated straight from the procedure's declared parameters — `getFeed(limit: Int?)` becomes `GetFeedArgs { limit?: number | null }`; `publishPost(args: PublishPostInput)` becomes `PublishPostArgs { args: PublishPostInput }`, mirroring the parameter name declared in the schema.

### TanStack Query hooks

```tsx
import {
  ExampleBlogClientClient,
  usePostListQuery,
  useCreatePostMutation,
} from "@example/blog-client";

function PostList({ client }: { client: ExampleBlogClientClient }) {
  const list = usePostListQuery(client, {
    query: { fields: ["id", "title"], limit: 20 },
    queryOptions: { staleTime: 30_000 },
  });
  const create = useCreatePostMutation(client);

  if (list.isPending) return null;
  if (list.isError) return <ErrorState error={list.error} />;

  return <PostListView data={list.data} onCreate={(input) => create.mutate(input)} />;
}
```

Every model gets `use{Model}ListQuery`, `use{Model}Query`, `useCreate{Model}Mutation`, `useUpdate{Model}Mutation`, and `useDelete{Model}Mutation`. Query procedures get `use{Procedure}Query`; mutation procedures get `use{Procedure}Mutation`.

## Using the RPC client

For a schema with `transport rpc` (the `widget_rpc.cstack` example above), the generated client speaks `POST /rpc/{op_id}` and `POST /rpc/batch` instead of per-model REST routes. The per-model API surface looks almost identical to REST — same method names, same accessor pattern — but every call is dispatched by a canonical op ID (`model.Widget.list`, `procedure.echoName`, …) rather than a URL path.

```ts
import { ExampleWidgetClientClient } from "@example/widget-client";

const client = new ExampleWidgetClientClient("https://api.example.com", {
  basePath: "/api",
});

const widgets = await client.widgets.list();
const widget = await client.widgets.get(1);
const created = await client.widgets.create({ id: 3, name: "New Widget" });
const updated = await client.widgets.update(1, { name: "Renamed" });
await client.widgets.delete(1);

const echoed = await client.procedures.echoName({ name: "hello" });
```

Batch multiple calls into a single round trip with `runtime.batch(...)` — per-frame errors don't poison the batch, each response frame reports its own success or failure:

```ts
const results = await client.runtime.batch([
  { id: 1, op: "model.Widget.get", input: { id: 1 } },
  { id: 2, op: "procedure.echoName", input: { name: "hi" } },
]);
```

Idempotency keys are a first-class call option on RPC unary calls (propagated as the `Idempotency-Key` header):

```ts
await client.widgets.create(input, { idempotencyKey: crypto.randomUUID() });
```

Sequence-returning ops can be consumed as an async iterable via `runtime.stream(...)`. Today this only decodes JSON-array responses — the default runtime doesn't yet ship a CBOR-sequence decoder, so a server that picks `application/cbor-seq` for a streaming call will surface `CratestackRpcTransportError` until a decoder is wired in.

TanStack Query hooks are generated for RPC schemas too, with the same naming as REST (`useWidgetListQuery`, `useEchoNameQuery`/`useEchoNameMutation` depending on whether the procedure is declared `query` or `mutation`).

## Side-by-side: TypeScript, Dart, and Rust

All three client generators (`cratestack-client-typescript`, `cratestack-client-dart`, `cratestack-client-rust`) work from the same `.cstack` schema and land on a deliberately similar shape: a top-level client object, one accessor per model, one `procedures` namespace. Below is the same four operations against `blog.cstack` — construct the client, list posts, create a post, call a query procedure, call a mutation procedure — in each language.

**Construct the client**

```ts
// TypeScript
import { ExampleBlogClientClient } from "@example/blog-client";

const client = new ExampleBlogClientClient("https://api.example.com", {
  basePath: "/cstack",
});
```

```dart
// Dart
final blogClient = BlogClientCrateStackClient(
  CrateStackRuntime(myBridge),
  basePath: '/cstack',
);
```

```rust
// Rust
use cratestack_client_rust::{ClientConfig, CratestackClient, CborCodec};

let runtime = CratestackClient::new(ClientConfig::new(base_url), CborCodec);
let client = cratestack_schema::client::Client::new(runtime);
```

**List posts**

```ts
// TypeScript
const posts = await client.posts.list({ query: { limit: 2 } });
```

```dart
// Dart
final posts = await blogClient.posts.list(
  query: (PostSelection()..id()).toListQuery(limit: 2),
);
```

```rust
// Rust
let posts = client.posts().list(&[("limit", "2")], &[]).await?;
```

**Create a post**

```ts
// TypeScript
const created = await client.posts.create({
  id: 3,
  title: "Created Post",
  subtitle: "created",
  published: true,
  authorId: 1,
});
```

```dart
// Dart
final created = await blogClient.posts.create(
  const CreatePostInput(
    id: 3,
    title: 'Created Post',
    subtitle: 'created',
    published: true,
    authorId: 1,
  ),
);
```

```rust
// Rust
let created = client
    .posts()
    .create(
        &cratestack_schema::CreatePostInput {
            id: 3,
            title: "Created Post".to_owned(),
            subtitle: Some("created".to_owned()),
            published: true,
            authorId: 1,
        },
        &[],
    )
    .await?;
```

**Call a query procedure**

```ts
// TypeScript
const feed = await client.procedures.getFeed({ limit: 10 });
```

```dart
// Dart
final feed = await blogClient.procedures.getFeed(
  const GetFeedArgs(limit: 10),
);
```

```rust
// Rust
let feed = client
    .procedures()
    .get_feed(&cratestack_schema::procedures::get_feed::Args { limit: Some(10) }, &[])
    .await?;
```

**Call a mutation procedure**

```ts
// TypeScript
const published = await client.procedures.publishPost({
  args: { postId: 1 },
});
```

```dart
// Dart
final publishedPost = await blogClient.procedures.publishPost(
  const PublishPostArgs(args: PublishPostInput(postId: 1)),
);
```

```rust
// Rust
let published = client
    .procedures()
    .publish_post(
        &cratestack_schema::procedures::publish_post::Args {
            args: cratestack_schema::PublishPostInput { postId: 1 },
        },
        &[],
    )
    .await?;
```

The pattern holds across languages: model accessors are named after the pluralized model (`posts` / `blogClient.posts` / `client.posts()`), procedures live under a `procedures` namespace, and identifiers are cased per-language convention — `camelCase` in TypeScript and Dart, `snake_case` in Rust — while the schema's own field/procedure names stay recognizable in all three.

## Caveats

- **Bundle size on large schemas.** The top-level client class eagerly `new`s a wrapper instance for every model in its constructor, so a bundler's tree-shaker can't drop an unused model's class if you only import the client — every model's ~30-line wrapper class is reachable from the one thing you imported. For schemas with a handful of models this is negligible; for schemas with dozens, it's a fixed cost baked into the client regardless of what you actually call.
- **No cross-language error type unification yet.** REST failures throw `CratestackHttpError` (status + response + payload), RPC failures throw `CratestackRpcError` (status + structured `RpcErrorBody` with a stable `code`), Dart and Rust each have their own error shapes. There's no shared error contract across the generated clients today.
- **Template overrides are all-or-nothing per file.** `--template-dir` overrides a `.j2` file wholesale; there's no partial-override or "extend the default template" mechanism.

## See also

- [`cratestack-client-typescript`](https://github.com/cratestack/cratestack/tree/main/crates/cratestack-client-typescript) — crate README, source of the CLI/Rust invocation examples above
- [Client Runtime](/architecture/client-runtime) — the Dart/Flutter integration path this guide's Rust and Dart examples are drawn from
- [RPC transport](/guides/rpc-transport) — full design for `transport rpc`
- [Transport Architecture](/architecture/transport-architecture)
