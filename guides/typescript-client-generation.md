---
title: TypeScript client generation
description: Generate a typed TypeScript package — REST or RPC, two output layouts, fetch client plus TanStack Query or SWR hooks — from a `.cstack` schema with `cratestack generate-typescript`, and compare the same call across TypeScript, Dart, and Rust clients.
---

# TypeScript client generation

`cratestack generate-typescript` renders a complete, publishable TypeScript package from a parsed `.cstack` schema: typed models, a fetch-based client, and data-fetching hooks. It's implemented by `cratestack-client-typescript` and uses the same schema-first approach as the Rust and Dart client generators — there is no OpenAPI/Swagger document in the middle, the `.cstack` file is the only source of truth.

This guide covers generating the package, its two output layouts (`default` and `swr`), what each contains, how to use them against both transport styles, the optional `@cratestack/*` package family for RPC clients, and how the same call looks across TypeScript, Dart, and Rust.

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
| `--check` | no | off | drift-detection mode: generate in memory and diff against `--out` instead of writing; exits non-zero and lists the files that differ |
| `--full-selection` | no | off | emit fully-required model interfaces instead of the projection-driven optional-everywhere default — see [Full selection: fully-required model types](#full-selection-fully-required-model-types) |
| `--preset` | no | `default` | output layout: `default` (today's monolithic `src/models.ts` + `src/client.ts` + ...) or `swr` (file-per-model, framework-free functions plus sibling SWR hooks) — see [Output layout: `default` vs `swr`](#output-layout-default-vs-swr) |

The client class name is derived from `--package-name`: non-alphanumeric characters become spaces, the result is PascalCased, and `Client` is appended. `@example/blog-client` becomes `ExampleBlogClientClient`. Pick a package name with that in mind if the resulting class name matters to you.

### From Rust

Call the generator directly when you're wiring codegen into your own build script, a CI step, or Studio-adjacent tooling, instead of shelling out to the CLI:

```rust
use cratestack_client_typescript::{TypeScriptGeneratorConfig, TypeScriptPreset, generate_package};

let schema = cratestack_parser::parse_schema_file("schema.cstack")?;
let package = generate_package(&schema, &TypeScriptGeneratorConfig {
    package_name: "@example/blog-client".to_owned(),
    base_path: "/cstack".to_owned(),
    preset: TypeScriptPreset::Default,
    ..Default::default()
})?;

for file in package.files {
    let path = out_dir.join(&file.file_name);
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(path, &file.contents)?;
}
```

`TypeScriptGeneratorConfig` implements `Default`, so the struct-update syntax above only needs to name the fields you're overriding — `full_selection`, `pb_lock` (`transport grpc` schemas only), and `schema_sha256` all take sane defaults otherwise.

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

## Output layout: `default` vs `swr`

`--preset` picks the shape of the generated package. Both presets work from the same schema, cover the same transports (REST or RPC, whichever `transport` the schema declares), and stay in sync with each other — `swr` just organizes the files differently and adds a hooks layer. `default` is the original layout and is guaranteed to stay byte-identical forever; `swr` is the newer file-per-model layout.

### The `default` layout

Every `default`-preset package ships `package.json`, `tsconfig.json`, `README.md`, and a `src/index.ts` barrel that re-exports everything. What's under `src/` beyond that depends on the schema's transport:

| File | REST | RPC | Contains |
|---|---|---|---|
| `src/models.ts` | ✓ | ✓ | model/input interfaces, enums, `Page<T>` |
| `src/runtime.ts` | ✓ | ✓ | `CratestackRuntime` (REST) or `CratestackRpcRuntime` (RPC) — the one place HTTP/serialization logic actually lives |
| `src/client.ts` | ✓ | ✓ | per-model API classes (`list`/`get`/`create`/`update`/`delete`) and `ProceduresApi`, all thin wrappers over the runtime |
| `src/queries.ts` | ✓ | — | `CratestackFetchQuery` / `toSearchQuery` — REST-only, since RPC dispatches by op ID instead of query-string projection params |
| `src/react-query.ts` | ✓ | ✓ | `useXListQuery`, `useCreateXMutation`, etc. — TanStack Query hooks over the client |

The per-model classes in `client.ts` aren't hardcoded fetch calls duplicated per endpoint — each method is a few lines that delegates into the single shared runtime class, so the actual request/serialization/error-handling logic exists once regardless of how many models the schema declares.

### The `swr` layout

```bash
cargo run -p cratestack-cli -- generate-typescript \
  --schema examples/react-vite-swr/schema.cstack \
  --out packages/board-client \
  --package-name @example/board-client \
  --base-path /api \
  --preset swr
```

Instead of one `client.ts` class fronting every model, `swr` emits one module per model plus a sibling hooks module:

| File | REST | RPC | Contains |
|---|---|---|---|
| `src/runtime.ts` | ✓ | ✓ | `CratestackRuntime` (REST) or `CratestackRpcRuntime` (RPC) — same runtime classes as the `default` preset |
| `src/queries.ts` | ✓ | — | `CratestackQueryRequestConfig`/`toSearchQuery` — REST-only |
| `src/links.ts` | — | ✓ | `RpcLink`/`RpcStreamLink` and the rest of the composable-chain types — RPC-only, see [Composable links](#composable-links-cratestack) below |
| `src/cbor-seq.ts` | — | ✓ | the CBOR-sequence boundary scanner backing `runtime.stream(...)` — RPC-only |
| `src/models/shared.ts` | ✓ | ✓ | types referenced by 2+ models, or by no model at all — see "Type ownership" below |
| `src/models/<model>.ts` | that model's own types plus a plain `async` function per CRUD verb (`listWidgets`, `getWidget`, `createWidget`, `updateWidget`, `deleteWidget`) — no client class, no framework import |
| `src/models/<model>.hooks.ts` | a **sibling** file: one `useSWR`/`useSWRMutation` hook per verb (`useWidgets`, `useWidget`, `useCreateWidget`, ...), each a thin wrapper that calls the plain function from `<model>.ts` |
| `src/procedures.ts` | one `<Name>Args` type and one plain `async` function per procedure |
| `src/procedures.hooks.ts` | one SWR hook per procedure — `useXQuery` for a `query` procedure, `useXMutation` for a `mutation` procedure |
| `src/swr-keys.ts` | `swrKeys` — the single shared cache-key factory every hook builds its key through |
| `src/index.ts` | re-exports the runtime, queries helper, `swrKeys`, every model's plain module, and `procedures.ts` — **not** the `.hooks` modules (see below) |

Given a `Widget` model, `listWidgets`/`getWidget`/`createWidget`/`updateWidget`/`deleteWidget` land in `src/models/widget.ts`:

```ts
import { CratestackRuntime, listWidgets, createWidget } from "@example/board-client";

const runtime = new CratestackRuntime("https://api.example.com", { basePath: "/api" });

const widgets = await listWidgets(runtime, { query: { limit: 20, sort: ["-id"] } });
const created = await createWidget(runtime, { id: 3, name: "New Widget" });
```

The hooks live in the sibling `widget.hooks.ts` and are imported from that subpath explicitly, never from the package root:

```tsx
import { useWidgets, useCreateWidget } from "@example/board-client/models/widget.hooks";

function WidgetList({ runtime }: { runtime: CratestackRuntime }) {
  const { data: widgets } = useWidgets(runtime);
  const { trigger: createWidget } = useCreateWidget(runtime);
  // ...
}
```

**Why hooks are a separate file, not exports at the bottom of `widget.ts`.** ES modules resolve every top-level static `import` eagerly, the moment the module loads — regardless of which export the importer actually asked for. If `useWidgets` lived in `widget.ts` alongside `listWidgets`, importing `listWidgets` alone from a script, a server action, or a test would still pull in `import useSWR from "swr"` (and transitively React) at module-load time, even though nothing in that code path touches React. Splitting the hooks into `widget.hooks.ts` — and leaving that file out of `src/index.ts`'s barrel export — means a consumer who wants only the plain functions never resolves `swr`/`react` at all. Install `swr` and `react` as peer dependencies only if you import a `.hooks` module.

**Cache keys and invalidation.** Every hook builds its key exclusively through `swrKeys` (`src/swr-keys.ts`) — never a hand-written literal — nested under each model's/procedure's own schema-unique route, so two differently-named operations can never collide on a key. Mutation hooks invalidate on a fixed rule, applied identically for every model:

- **create** invalidates the model's list — every cached list, regardless of `query` filter/pagination.
- **update** invalidates the list **and** the mutated entity's own detail (both refetch on next read).
- **delete** invalidates the list **and** drops the deleted entity's detail from the cache outright (`revalidate: false` — nothing left to refetch).

This rule isn't configurable per call. If you need different invalidation, call `mutate`/`swrKeys` directly instead of the generated hook. Procedure hooks never invalidate anything — invalidation is model CRUD's job.

**Type ownership.** A type referenced by exactly one model is defined inline in that model's own file. A type referenced by two or more models, referenced only by a procedure, or declared but unused, lives in `src/models/shared.ts` and is imported by its consumers instead. A relation field that references another model's own type (e.g. `author: User` on a `Post`) is always imported with `import type`, never a value import, so two models that reference each other can only ever produce a type-only import cycle — which TypeScript tolerates — never a runtime one.

**Known gaps.** As of this writing, `swr` doesn't support `transport grpc` schemas, and doesn't yet special-case `@@paged` models (it never imports `Page`/`PageInfo` for one) — both are tracked as generator follow-ups, not permanent limitations.

## Build the generated package

The generator emits an npm package skeleton, not compiled JS — build it before consuming it:

```bash
cd packages/blog-client
npm install
npm run build   # runs `tsc -p tsconfig.json`, emits dist/
```

The `default` preset lists `@tanstack/react-query` as a `peerDependency`, so `npm install` won't pull it in on its own — only install it if you're going to import the generated React Query hooks. The `swr` preset instead lists `swr` and `react` as peer dependencies, needed only if you import a `.hooks` module — importing a model's plain functions or `procedures.ts` needs neither.

## Full selection: fully-required model types

By default, every scalar field on a generated model interface is optional — because a REST `list`/`get` call can return a partial projection via `fields`/`include`, the static type has to allow for any field being absent from the wire response:

```ts
export interface Widget {
  id?: number;
  name?: string;
  weight?: number | null;
}
```

That's correct for a consumer who sometimes requests partial objects, but it's dead weight for a consumer whose runtime never does — every read of `widget.id` has to be narrowed or non-null-asserted even though the field is always present in practice. Pass `--full-selection` to opt a generation run out of that:

```bash
cargo run -p cratestack-cli -- generate-typescript \
  --schema crates/cratestack-pg/tests/fixtures/blog.cstack \
  --out packages/blog-client \
  --package-name @example/blog-client \
  --base-path /cstack \
  --full-selection
```

With the flag, the same `Widget` (`id Int @id`, `name String`, `weight Int?` in the schema) becomes:

```ts
export interface Widget {
  id: number;
  name: string;
  weight?: number | null;
}
```

Field presence now tracks the schema's own nullability instead of wire-projection optionality: `id`/`name` are required because the schema declares them non-nullable, and `weight` stays optional because the schema declares it nullable (`Int?`) — that part of the contract doesn't change. Only the plain per-model read interface is affected. `Create{Model}Input` already derives optionality from schema nullability and is untouched; `Update{Model}Input` stays entirely optional, since PATCH semantics mean every field is inherently a partial update regardless of this flag.

This is a per-invocation choice, not a schema-level one — deliberately. Whether a given client always fetches full objects or sometimes uses `fields`/`include` is a property of how that particular consumer calls the API, not of the schema itself; two client packages generated from the same schema can pick differently. Omitting the flag leaves existing generated output unchanged.

**Only use `--full-selection` for a consumer that truly never sends partial `fields`/`include` selection.** If that consumer's runtime later starts using projection, the generated types will silently no longer match what the server can actually omit from the response — there's no runtime check tying the flag to actual call sites.

## Using the REST client

The examples in this section and the next use the `default` preset's client-class API. For the `swr` preset's per-model function/hook API, see [The `swr` layout](#the-swr-layout) above.

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

Two argument types get dedicated generated shapes rather than a plain scalar mapping: `PageInput` (`{ limit: number | null; offset: number | null; }`, hardcoded once per package) and `FindMany<Model>` (a per-model `PostWhere`/`PostFindMany` pair, backed by shared `StringFilter`/`NumberFilter`/etc. interfaces) — see [Pagination](../guides/pagination#procedure-arguments-pageinput) and [Search with Filters](../guides/find-many) for the full contract each one generates.

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

Sequence-returning ops can be consumed as an async iterable via `runtime.stream(...)`:

```ts
for await (const ping of client.runtime.stream<Ping>("procedure.manyPings", {})) {
  render(ping);
}
```

When the server picks the negotiated codec (`application/cbor` by default), the body is a single array decoded and yielded in one go. When the server picks `application/cbor-seq` for a genuinely-incremental `@stream` procedure, the runtime's own CBOR-sequence boundary scanner decodes and yields each item as it arrives on the wire — never after buffering the whole body first. A response that ends in the mid-stream error sentinel throws `CratestackRpcStreamError` instead of yielding a final item. See the [RPC transport guide's "Consuming streams" section](/guides/rpc-transport#consuming-streams) for the wire-level details and how this compares to the Rust/Flutter/dio client paths.

`CratestackRpcClientOptions` also accepts a `links?: RpcLink[]` array for composing cross-cutting concerns (logging, retry, auth-refresh, automatic batch coalescing via `@cratestack/api`) in front of `call()`/`batch()` without one override clobbering another — see [RPC transport: client middleware](./rpc-transport#client-middleware-the-rpclink-chain) for the full design. `stream()` calls bypass `links` entirely.

TanStack Query hooks are generated for RPC schemas too, with the same naming as REST (`useWidgetListQuery`, `useEchoNameQuery`/`useEchoNameMutation` depending on whether the procedure is declared `query` or `mutation`).

### Composable links: `@cratestack/*`

`CratestackRpcRuntime` accepts a `links` array (unary/batch calls) and a separate `streamLinks` array (`stream()` calls) — interceptor chains where each link wraps the next, terminating in the real network call. Passing neither is a true no-op: requests are byte-identical to not having the option at all. Both types (`RpcLink`, `RpcStreamLink`, `RpcLinkRequest`, ...) are generated directly into `src/links.ts`, so a link doesn't need to import anything from the generated package to be assignable there — TypeScript's structural typing means any object shaped like `RpcLink` fits.

That structural fit is what the `@cratestack/*` npm family builds on: nine small packages (plus a backward-compatible umbrella) that ship ready-made links, alternate transports, and framework adapters for **RPC-transport** generated clients, published and installable independently of the generated package itself:

| Package | What it is |
|---|---|
| [`@cratestack/ts-types`](https://www.npmjs.com/package/@cratestack/ts-types) | Shared `RpcLink`/wire-frame interfaces, pinned copies of the generated types. Types only. |
| [`@cratestack/link-batch`](https://www.npmjs.com/package/@cratestack/link-batch) | `createBatchLink()` — a [batshit](https://github.com/yornaath/batshit)-style scheduler that collapses unary calls issued in the same tick into one `POST /rpc/batch` request. |
| [`@cratestack/link-logger`](https://www.npmjs.com/package/@cratestack/link-logger) | `createLoggerLink()` — reference link that logs each call's kind, op id, outcome, and duration. |
| [`@cratestack/runtime-fetch`](https://www.npmjs.com/package/@cratestack/runtime-fetch) | `createFetchRuntime({ timeoutMs })` — a `typeof fetch`-compatible transport, byte-identical to the global `fetch` with no options. |
| [`@cratestack/runtime-axios`](https://www.npmjs.com/package/@cratestack/runtime-axios) | `createAxiosRuntime({ instance })` — the same transport contract, backed by axios. |
| [`@cratestack/validator-zod`](https://www.npmjs.com/package/@cratestack/validator-zod) | `createZodValidatorLink({ "model.Order.create": schema, ... })` — validates `input` against a per-op zod schema before the call reaches the network. |
| [`@cratestack/validator-yup`](https://www.npmjs.com/package/@cratestack/validator-yup) | Same idea, yup schemas. |
| [`@cratestack/adapter-tanstack-query`](https://www.npmjs.com/package/@cratestack/adapter-tanstack-query) | `rpcQueryOptions`/`rpcMutationOptions` — generic TanStack Query option builders for hand-written hooks the generated `react-query.ts` doesn't cover. |
| [`@cratestack/adapter-rtk`](https://www.npmjs.com/package/@cratestack/adapter-rtk) | `createRpcBaseQuery(...)` — an RTK Query `BaseQueryFn` that dispatches through the same runtime and link chain. |

```ts
import { createBatchLink, createLoggerLink } from "@cratestack/api";
import { ExampleWidgetClientClient } from "@example/widget-client";

const client = new ExampleWidgetClientClient("https://api.example.com", {
  links: [createLoggerLink(), createBatchLink()],
});

// Issued inside the same tick — collapses into a single POST /rpc/batch:
const [a, b, c] = await Promise.all([
  client.widgets.get(1),
  client.widgets.get(2),
  client.widgets.get(3),
]);
```

`@cratestack/api` is a backward-compatible re-export shim over the split, not a tenth independent package — its root import stays exactly `ts-types` + `link-batch` + `link-logger` (unchanged from before the split), and everything else added since is a named subpath that pulls in only its own peer dependency:

```ts
import { createZodValidatorLink } from "@cratestack/api/validator-zod";
import { rpcQueryOptions } from "@cratestack/api/adapter-tanstack-query";
```

New projects can install the individual packages directly instead — smaller install, no unused peer dependencies pulled in through the umbrella. Every package in the family is scoped to RPC-transport generated clients; none of it applies to `transport rest` schemas, since the REST client has no `links`/`streamLinks` chain to plug into.

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

- **Bundle size on large schemas, `default` preset only.** The top-level client class eagerly `new`s a wrapper instance for every model in its constructor, so a bundler's tree-shaker can't drop an unused model's class if you only import the client — every model's ~30-line wrapper class is reachable from the one thing you imported. For schemas with a handful of models this is negligible; for schemas with dozens, it's a fixed cost baked into the client regardless of what you actually call. The `swr` preset's file-per-model layout doesn't have this problem — importing one model's module never reaches another's.
- **No cross-language error type unification yet.** REST failures throw `CratestackHttpError` (status + response + payload), RPC failures throw `CratestackRpcError` (status + structured `RpcErrorBody` with a stable `code`), Dart and Rust each have their own error shapes. There's no shared error contract across the generated clients today.
- **Template overrides are all-or-nothing per file.** `--template-dir` overrides a `.j2` file wholesale; there's no partial-override or "extend the default template" mechanism.
- **`swr` preset gaps.** No `transport grpc` support yet, and no special-cased `Page`/`PageInfo` handling for `@@paged` models — both tracked as generator follow-ups.

## See also

- [`cratestack-client-typescript`](https://github.com/cratestack/cratestack/tree/main/crates/cratestack-client-typescript) — crate README, source of the CLI/Rust invocation examples above
- [`@cratestack/api`](https://github.com/cratestack/cratestack/tree/main/packages/cratestack-api) — the compat umbrella over the split link/runtime/validator/adapter package family
- [Client Runtime](/architecture/client-runtime) — the Dart/Flutter integration path this guide's Rust and Dart examples are drawn from
- [RPC transport](/guides/rpc-transport) — full design for `transport rpc`, including the "Consuming streams" section this guide's `runtime.stream(...)` example links back to
- [Transport Architecture](/architecture/transport-architecture)
