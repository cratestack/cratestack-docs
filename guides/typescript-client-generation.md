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
| `--swr` | no | off | *additionally* emit a file-per-model layout with SWR hooks under `src/swr/`, alongside the default layout — see [Adding the SWR layout with `--swr`](#adding-the-swr-layout-with---swr) |
| `--refine` | no | off | *additionally* emit `src/refine.ts`, the [`@cratestack/refine`](https://www.npmjs.com/package/@cratestack/refine) resource manifest for the schema |
| `--no-native-cbor` | no | off | RPC transport only: fall back to the pure-TypeScript `jsonRpcCodec` instead of the native [`@cratestack/cbor`](https://www.npmjs.com/package/@cratestack/cbor) codec, which is the default — see [The CBOR codec](#the-cbor-codec) |

The client class name is derived from `--package-name`: non-alphanumeric characters become spaces, the result is PascalCased, and `Client` is appended. `@example/blog-client` becomes `ExampleBlogClientClient`. Pick a package name with that in mind if the resulting class name matters to you.

### From Rust

Call the generator directly when you're wiring codegen into your own build script, a CI step, or Studio-adjacent tooling, instead of shelling out to the CLI:

```rust
use cratestack_client_typescript::{TypeScriptGeneratorConfig, generate_package};

let schema = cratestack_parser::parse_schema_file("schema.cstack")?;
let package = generate_package(&schema, &TypeScriptGeneratorConfig {
    package_name: "@example/blog-client".to_owned(),
    base_path: "/cstack".to_owned(),
    swr: true, // omit (or `false`) for the default layout only
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

## Output layout

Every generated package ships the layout below. `--swr` **adds** a second, file-per-model layout beside it under `src/swr/` — it does not replace anything, and the files described here are identical whether or not you pass it.

<Note>
This replaced a `--preset <default|swr>` flag, where picking `swr` meant giving up the default layout. Teams who wanted both were running the generator twice into two directories and depending on two packages. One run now produces both. If you have `--preset swr` in a script, drop it and pass `--swr`; if you have `--preset default`, just remove it.
</Note>

### The default layout

Every generated package ships `package.json`, `tsconfig.json`, `README.md`, and a `src/index.ts` barrel that re-exports everything. What's under `src/` beyond that depends on the schema's transport:

| File | REST | RPC | Contains |
|---|---|---|---|
| `src/models.ts` | ✓ | ✓ | model/input interfaces, enums, `Page<T>` |
| `src/runtime.ts` | ✓ | ✓ | `CratestackRuntime` (REST) or `CratestackRpcRuntime` (RPC) — the one place HTTP/serialization logic actually lives |
| `src/client.ts` | ✓ | ✓ | per-model API classes (`list`/`get`/`create`/`update`/`delete`) and `ProceduresApi`, all thin wrappers over the runtime |
| `src/queries.ts` | ✓ | ✓ | REST: `CratestackFetchQuery` / `toSearchQuery`. RPC: `CratestackRpcListQuery` / `toRpcListInput` — same job, shaped for RPC's plain-object list input instead of a URL query string |
| `src/react-query.ts` | ✓ | ✓ | `useXListQuery`, `useCreateXMutation`, etc. — TanStack Query hooks over the client |
| `src/links.ts` | — | ✓ | `RpcLink`/`RpcStreamLink` and the rest of the composable-chain types — RPC-only, see [Composable links](#composable-links-cratestack) below |
| `src/cbor-item.ts` | — | ✓ | the low-level single-CBOR-item structural walker (item-boundary skipping) that `cbor-seq.ts`'s stateful scanner is built on — RPC-only |
| `src/cbor-seq.ts` | — | ✓ | the stateful `application/cbor-seq` boundary scanner backing `runtime.stream(...)` — RPC-only |
| `src/stream-terminal.ts` | — | ✓ | the `streamLinks` chain's terminal link — performs the real network call for `runtime.stream(...)` and turns the response into the yielded `AsyncIterable` — RPC-only |

The per-model classes in `client.ts` aren't hardcoded fetch calls duplicated per endpoint — each method is a few lines that delegates into the single shared runtime class, so the actual request/serialization/error-handling logic exists once regardless of how many models the schema declares.

### Adding the SWR layout with `--swr`

```bash
cargo run -p cratestack-cli -- generate-typescript \
  --schema examples/react-vite-swr/schema.cstack \
  --out packages/board-client \
  --package-name @example/board-client \
  --base-path /api \
  --swr
```

Everything from the default layout is still there. In addition, under `src/swr/`, you get one module per model plus a sibling hooks module — reachable by a consumer as `@example/board-client/swr` (plus `/swr/models/*`, `/swr/procedures`, `/swr/procedures.hooks`) through `exports` subpaths the flag adds to the generated `package.json`:

| File | REST | RPC | Contains |
|---|---|---|---|
| `src/swr/runtime.ts` | ✓ | ✓ | `CratestackRuntime` (REST) or `CratestackRpcRuntime` (RPC) — the same runtime classes the default layout emits, re-rendered here so `/swr` is self-contained |
| `src/swr/queries.ts` | ✓ | ✓ | REST: `CratestackQueryRequestConfig`/`toSearchQuery`. RPC: `CratestackRpcListQuery`/`toRpcListInput` — the same templates the default layout uses |
| `src/swr/links.ts` | — | ✓ | `RpcLink`/`RpcStreamLink` and the rest of the composable-chain types — RPC-only, see [Composable links](#composable-links-cratestack) below |
| `src/swr/cbor-item.ts` | — | ✓ | the low-level single-CBOR-item structural walker (item-boundary skipping) that `cbor-seq.ts`'s stateful scanner is built on — RPC-only |
| `src/swr/cbor-seq.ts` | — | ✓ | the stateful `application/cbor-seq` boundary scanner backing `runtime.stream(...)` — RPC-only |
| `src/swr/stream-terminal.ts` | — | ✓ | the `streamLinks` chain's terminal link — performs the real network call for `runtime.stream(...)` and turns the response into the yielded `AsyncIterable` — RPC-only |
| `src/swr/models/shared.ts` | ✓ | ✓ | types referenced by 2+ models, or by no model at all — see "Type ownership" below |
| `src/swr/models/<model>.ts` | that model's own types plus a plain `async` function per CRUD verb (`listWidgets`, `getWidget`, `createWidget`, `updateWidget`, `deleteWidget`) — no client class, no framework import |
| `src/swr/models/<model>.hooks.ts` | a **sibling** file: one `useSWR`/`useSWRMutation` hook per verb (`useWidgets`, `useWidget`, `useCreateWidget`, ...), each a thin wrapper that calls the plain function from `<model>.ts` |
| `src/swr/procedures.ts` | one `<Name>Args` type and one plain `async` function per procedure |
| `src/swr/procedures.hooks.ts` | one SWR hook per procedure — `useXQuery` for a `query` procedure, `useXMutation` for a `mutation` procedure |
| `src/swr/swr-keys.ts` | `swrKeys` — the single shared cache-key factory every hook builds its key through |
| `src/swr/index.ts` | re-exports the runtime, queries helper, `swrKeys`, every model's plain module, and `procedures.ts` — **not** the `.hooks` modules (see below) |

Given a `Widget` model, `listWidgets`/`getWidget`/`createWidget`/`updateWidget`/`deleteWidget` land in `src/swr/models/widget.ts`:

```ts
// Note the `/swr` subpath — these are the SWR layout's plain functions,
// and its own `CratestackRuntime`. See the warning below on why the root
// package's runtime is not interchangeable with this one.
import { CratestackRuntime, listWidgets, createWidget } from "@example/board-client/swr";

const runtime = new CratestackRuntime("https://api.example.com", { basePath: "/api" });

const widgets = await listWidgets(runtime, { query: { limit: 20, sort: ["-id"] } });
const created = await createWidget(runtime, { id: 3, name: "New Widget" });
```

The hooks live in the sibling `widget.hooks.ts` and are imported from that subpath explicitly, never from `/swr`'s own barrel:

```tsx
import { useWidgets, useCreateWidget } from "@example/board-client/swr/models/widget.hooks";

function WidgetList({ runtime }: { runtime: CratestackRuntime }) {
  const { data: widgets } = useWidgets(runtime);
  const { trigger: createWidget } = useCreateWidget(runtime);
  // ...
}
```

**Why hooks are a separate file, not exports at the bottom of `widget.ts`.** ES modules resolve every top-level static `import` eagerly, the moment the module loads — regardless of which export the importer actually asked for. If `useWidgets` lived in `widget.ts` alongside `listWidgets`, importing `listWidgets` alone from a script, a server action, or a test would still pull in `import useSWR from "swr"` (and transitively React) at module-load time, even though nothing in that code path touches React. Splitting the hooks into `widget.hooks.ts` — and leaving that file out of `src/index.ts`'s barrel export — means a consumer who wants only the plain functions never resolves `swr`/`react` at all. Install `swr` and `react` as peer dependencies only if you import a `.hooks` module.

<Warning>
**Build your shared runtime from `/swr` if you use the SWR hooks.** The default layout's `CratestackRuntime` and the one under `/swr` are structurally identical but *nominally distinct* TypeScript classes (they carry private fields), so passing a root-imported runtime into a `/swr` hook is a type error. This could not happen under the old `--preset swr`, where a package only ever contained one layout — it is new with `--swr`, and it is the first thing to check if `tsc` complains about two types that look the same.
</Warning>

**Cache keys and invalidation.** Every hook builds its key exclusively through `swrKeys` (`src/swr/swr-keys.ts`) — never a hand-written literal — nested under each model's/procedure's own schema-unique route, so two differently-named operations can never collide on a key. Mutation hooks invalidate on a fixed rule, applied identically for every model:

- **create** invalidates the model's list — every cached list, regardless of `query` filter/pagination.
- **update** invalidates the list **and** the mutated entity's own detail (both refetch on next read).
- **delete** invalidates the list **and** drops the deleted entity's detail from the cache outright (`revalidate: false` — nothing left to refetch).

This rule isn't configurable per call. If you need different invalidation, call `mutate`/`swrKeys` directly instead of the generated hook. Procedure hooks never invalidate anything — invalidation is model CRUD's job.

**Type ownership.** A type referenced by exactly one model is defined inline in that model's own file. A type referenced by two or more models, referenced only by a procedure, or declared but unused, lives in `src/swr/models/shared.ts` and is imported by its consumers instead. A relation field that references another model's own type (e.g. `author: User` on a `Post`) is always imported with `import type`, never a value import, so two models that reference each other can only ever produce a type-only import cycle — which TypeScript tolerates — never a runtime one.

**Known gaps.** `--swr` doesn't support `transport grpc` schemas — tracked as a generator follow-up, not a permanent limitation. `@@paged` models are handled correctly: every file that needs it imports `Page`/`PageInfo` from `src/swr/models/shared.ts`, same as the default layout. For `transport rpc` schemas, `--swr` also ignores the codec default entirely — `src/swr/runtime.ts` stays on `jsonRpcCodec` regardless of `--no-native-cbor` — see [The CBOR codec](#the-cbor-codec) below.

## Build the generated package

The generator emits an npm package skeleton, not compiled JS — build it before consuming it:

```bash
cd packages/blog-client
npm install
npm run build   # runs `tsc -p tsconfig.json`, emits dist/
```

The generated `package.json` lists `@tanstack/react-query` as a `peerDependency`, so `npm install` won't pull it in on its own — only install it if you're going to import the generated React Query hooks. With `--swr` the manifest additionally lists `swr` and `react`, needed only if you import a `.hooks` module — importing a model's plain functions or `src/swr/procedures.ts` needs neither.

For a `transport rpc` schema, the manifest also lists `@cratestack/cbor` under real `dependencies` (not `peerDependencies`) — `npm install` pulls it in automatically, no opt-in step required — because the RPC runtime resolves it by default (see [The CBOR codec](#the-cbor-codec) below). Pass `--no-native-cbor` and that dependency is absent instead. REST-transport packages never carry it either way; `rest-runtime.ts.j2` has no codec seam.

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

The examples in this section and the next use the default layout's client-class API. For the per-model function/hook API `--swr` adds, see [Adding the SWR layout with `--swr`](#adding-the-swr-layout-with---swr) above.

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

When the server picks the negotiated non-streaming codec (CBOR by default — see below), the body is a single array decoded and yielded in one go. When the server picks `application/cbor-seq` for a genuinely-incremental `@stream` procedure, the runtime's own CBOR-sequence boundary scanner decodes and yields each item as it arrives on the wire — never after buffering the whole body first. A response that ends in the mid-stream error sentinel throws `CratestackRpcStreamError` instead of yielding a final item. See the [RPC transport guide's "Consuming streams" section](/guides/rpc-transport#consuming-streams) for the wire-level details and how this compares to the Rust/Flutter/dio client paths.

`CratestackRpcClientOptions` also accepts a `links?: RpcLink[]` array for composing cross-cutting concerns (logging, retry, auth-refresh, automatic batch coalescing via `@cratestack/api`) in front of `call()`/`batch()` without one override clobbering another — see [RPC transport: client middleware](./rpc-transport#client-middleware-the-rpclink-chain) for the full design. `stream()` calls bypass `links` entirely.

TanStack Query hooks are generated for RPC schemas too, with the same naming as REST (`useWidgetListQuery`, `useEchoNameQuery`/`useEchoNameMutation` depending on whether the procedure is declared `query` or `mutation`).

### Composable links: `@cratestack/*`

`CratestackRpcRuntime` accepts a `links` array (unary/batch calls) and a separate `streamLinks` array (`stream()` calls) — interceptor chains where each link wraps the next, terminating in the real network call. Passing neither is a true no-op: requests are byte-identical to not having the option at all. Both types (`RpcLink`, `RpcStreamLink`, `RpcLinkRequest`, ...) are generated directly into `src/links.ts`, so a link doesn't need to import anything from the generated package to be assignable there — TypeScript's structural typing means any object shaped like `RpcLink` fits.

That structural fit is what the `@cratestack/*` npm family builds on: twelve small packages (plus a backward-compatible umbrella) that ship ready-made links, alternate transports, codecs, and framework adapters for **RPC-transport** generated clients, published and installable independently of the generated package itself:

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
| [`@cratestack/cbor-node`](https://www.npmjs.com/package/@cratestack/cbor-node) | Native N-API CBOR codec (wraps the framework's `cratestack-codec-cbor` Rust crate via `crates/cratestack-cbor-napi`) for byte-identical wire behavior with the server and Rust client, in Node. |
| [`@cratestack/cbor-web`](https://www.npmjs.com/package/@cratestack/cbor-web) | wasm-bindgen CBOR codec for browsers — async one-time WASM init, synchronous encode/decode after, backed by the same Rust `CborCodec`. |
| [`@cratestack/cbor`](https://www.npmjs.com/package/@cratestack/cbor) | Umbrella package: conditional `exports` auto-select `@cratestack/cbor-node` in Node or `@cratestack/cbor-web` in the browser behind one import path and one async `createCborCodec()` factory. |

See [The CBOR codec](#the-cbor-codec) below for what the generated RPC runtime resolves by default and how to opt back into JSON.

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

`@cratestack/api` is a backward-compatible re-export shim over the split, not a thirteenth independent package — its root import stays exactly `ts-types` + `link-batch` + `link-logger` (unchanged from before the split), and everything else added since is a named subpath that pulls in only its own peer dependency:

```ts
import { createZodValidatorLink } from "@cratestack/api/validator-zod";
import { rpcQueryOptions } from "@cratestack/api/adapter-tanstack-query";
```

New projects can install the individual packages directly instead — smaller install, no unused peer dependencies pulled in through the umbrella. Every package in the family is scoped to RPC-transport generated clients; none of it applies to `transport rest` schemas, since the REST client has no `links`/`streamLinks` chain to plug into.

## The CBOR codec

By default, a generated `transport rpc` client resolves [`@cratestack/cbor`](https://www.npmjs.com/package/@cratestack/cbor)'s `createCborCodec()` (issue [#746](https://github.com/cratestack/cratestack/issues/746)) — the same umbrella package listed in the table above, auto-selecting `@cratestack/cbor-node` in Node or `@cratestack/cbor-web` in the browser. Because both sides are the same Rust `CborCodec` the server uses, the wire bytes are identical across languages, the same property `cratestack_cbor` gives the Dart client and `cratestack-client-rust` gives the Rust one. The default request/response `Content-Type`/`Accept` becomes `application/cbor` accordingly.

The constructor stays synchronous even though `createCborCodec()` is async: the runtime lazily creates and memoizes the codec promise, awaiting it right after `buildHeaders()` on each call, and a *rejected* resolution is not memoized — a transient init failure retries on the next call rather than permanently bricking the runtime instance. `codec:` in `CratestackRpcClientOptions` still overrides synchronously and skips resolution entirely, exactly as before.

Pass `--no-native-cbor` at generation time to opt back into the pure-TypeScript `jsonRpcCodec` (`application/json`) instead — the same escape hatch Dart's `--no-native-cbor` provides:

```bash
cargo run -p cratestack-cli -- generate-typescript \
  --schema schema.cstack \
  --out packages/widget-client \
  --package-name @example/widget-client \
  --no-native-cbor
```

Or keep the native default and pass `jsonRpcCodec` explicitly at the call site instead of regenerating:

```ts
import { jsonRpcCodec } from "@example/widget-client";
import { ExampleWidgetClientClient } from "@example/widget-client";

const client = new ExampleWidgetClientClient("https://api.example.com", {
  codec: jsonRpcCodec,
});
```

This is no longer a TypeScript-specific asymmetry — Rust (`cratestack-client-rust`), Dart (`cratestack_cbor`, issue [#563](https://github.com/cratestack/cratestack/issues/563)), and TypeScript RPC clients all default to CBOR now. Only REST-transport TypeScript clients are unaffected: `rest-runtime.ts.j2` has no codec seam, so a REST client stays JSON-only regardless of this flag.

### Platform support

`@cratestack/cbor-node`'s native N-API binary is only vendored for some platforms:

| Platform | Supported |
|---|---|
| macOS (x64, arm64) | yes |
| Linux x64 (glibc) | yes |
| Linux arm64 (glibc) | yes |
| Windows x64 | yes |
| Linux x64/arm64 (musl, e.g. Alpine) | **no** |
| Windows arm64 | **no** |

`@cratestack/cbor-web`'s wasm-bindgen build has no platform gap — it runs anywhere a browser or a WASM-capable JS runtime does.

<Warning>
  **Alpine (musl) and Windows arm64 are why `--no-native-cbor` exists for TypeScript.** A default-generated RPC client's `dependencies` on `@cratestack/cbor` resolves to `@cratestack/cbor-node` in Node, which has no prebuild for those two targets. If your deployment target is one of them, pass `--no-native-cbor` at generation time and the client falls back to the pure-TypeScript `jsonRpcCodec` — no native binary required, runs anywhere Node or a browser does.
</Warning>

<Warning>
  **`--swr` ignores this default entirely — known bug, [#765](https://github.com/cratestack/cratestack/issues/765).** `src/swr/runtime.ts` renders from the same `rpc-runtime.ts.j2` template as `src/runtime.ts`, but through a `SwrSchemaContext` that has no `native_cbor` field, so every `{% if native_cbor %}` branch in the template is falsy there regardless of `--no-native-cbor`. Because `--swr` is *additive* (the default `src/` layout is always emitted alongside it), one generated package ends up with two runtimes on two different default codecs: `src/runtime.ts` defaults to `application/cbor`, `src/swr/runtime.ts` defaults to `application/json`. Measured on a real `--swr`-only run: 7 `createCborCodec` occurrences in `src/runtime.ts`, 0 in `src/swr/runtime.ts` — `package.json` lists `@cratestack/cbor` either way. In practice, the same operation goes out as CBOR through the default-layout client and as JSON through the `/swr` hooks; against a CBOR-only server, the SWR half of your app fails while the rest works. REST-transport `--swr` is unaffected — REST has no codec seam. Until #765 lands, don't mix `--swr` and the default layout against the same RPC server, or a server whose `CodecSet` doesn't also accept JSON.
</Warning>

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
final blogClient = BlogClientCratestackClient(
  CratestackDioAdapter(dio: myDio),
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

The pattern holds across languages: model accessors are named after the pluralized model (`posts` / `blogClient.posts` / `client.posts()`), procedures live under a `procedures` namespace, and only method/procedure names are cased per-language convention — `camelCase` in TypeScript and Dart, `snake_case` in Rust (`.posts()`, `get_feed`). Struct field names (e.g. `authorId`, `postId`) keep the schema's own original casing verbatim in all three languages, Rust included — there's no serde rename, so a Rust `CreatePostInput` literal still reads `authorId: 1`, not `author_id: 1`, as the code samples above show.

## Computed-field params

A model with a `@computed(params: <Type>?)` field gets a generated
`<Model>ComputedParams` interface, and the shared query types are generic over
it (`CratestackFetchQuery<TComputedParams = never>`) — so `computedParams` is
fully typed on parameterized models and a **compile error** on everything else:

```typescript
const image = await client.images.get(7, {
  computedParams: { proxyUrl: { width: 800 } },
});
```

This works on both the REST and RPC clients and through the `/swr` layout, whose
cache keys incorporate the params so differently-parameterized reads never
collide. The RPC client's per-model `get` options bag also carries the
projection surface — `fields`, `include`, and `includeFields` — mirroring what
`CratestackFetchQuery` has always given REST `get`, so a projected,
parameterized read is one call:

```typescript
const image = await client.images.get(7, {
  fields: ["id", "proxyUrl"],
  computedParams: { proxyUrl: { width: 800 } },
});
```

See [Computed Fields](/guides/computed-fields) for the schema side and the wire
format.

## Caveats

- **Bundle size on large schemas, default layout only.** The top-level client class eagerly `new`s a wrapper instance for every model in its constructor, so a bundler's tree-shaker can't drop an unused model's class if you only import the client — every model's ~30-line wrapper class is reachable from the one thing you imported. For schemas with a handful of models this is negligible; for schemas with dozens, it's a fixed cost baked into the client regardless of what you actually call. The `/swr` file-per-model layout doesn't have this problem — importing one model's module never reaches another's.
- **No cross-language error type unification yet.** REST failures throw `CratestackHttpError` (status + response + payload), RPC failures throw `CratestackRpcError` (status + structured `RpcErrorBody` with a stable `code`), Dart and Rust each have their own error shapes. There's no shared error contract across the generated clients today.
- **Template overrides are all-or-nothing per file.** `--template-dir` overrides a `.j2` file wholesale; there's no partial-override or "extend the default template" mechanism.
- **`--swr` gap.** No `transport grpc` support yet — tracked as a generator follow-up. `@@paged` models are supported: `Page`/`PageInfo` are imported into every file that needs them, same as the default layout.
- **Regenerating an existing RPC client silently switches its wire codec from JSON to CBOR.** Since issue [#746](https://github.com/cratestack/cratestack/issues/746), the native `@cratestack/cbor` codec — and `application/cbor` as the default `Content-Type`/`Accept` — is on by default for `transport rpc` schemas. Re-running `generate-typescript` against an `--out` directory generated before that change (or with an older CLI) upgrades it in place with no warning at generation time. Before regenerating a client that talks to a live server, confirm the server's `CodecSet` includes `CborCodec` (`CodecSet::new(CborCodec, JsonCodec)` — see [RPC transport](/guides/rpc-transport#mounting-the-router)) — a JSON-only `CodecSet` will reject the regenerated client with `406`/`415`. Otherwise pass `--no-native-cbor` to keep the client on JSON.
- **`--swr` ignores `native_cbor` for `transport rpc` schemas — known bug, [#765](https://github.com/cratestack/cratestack/issues/765).** `src/swr/runtime.ts` renders from the same template as `src/runtime.ts` but through a context with no `native_cbor` field, so it always falls back to `jsonRpcCodec`/`application/json`, regardless of `--no-native-cbor`. Since `--swr` is additive, one generated package ends up with the default layout's `src/runtime.ts` defaulting to CBOR and `src/swr/runtime.ts` defaulting to JSON — the same operation is sent as CBOR through the plain client and JSON through the SWR hooks. REST-transport `--swr` is unaffected. See [The CBOR codec](#the-cbor-codec) for the full explanation until this is fixed upstream.

## See also

- [`cratestack-client-typescript`](https://github.com/cratestack/cratestack/tree/main/crates/cratestack-client-typescript) — crate README, source of the CLI/Rust invocation examples above
- [`@cratestack/api`](https://github.com/cratestack/cratestack/tree/main/packages/cratestack-api) — the compat umbrella over the split link/runtime/validator/adapter package family
- [Client Runtime](/architecture/client-runtime) — the Dart/Flutter integration path this guide's Rust and Dart examples are drawn from
- [RPC transport](/guides/rpc-transport) — full design for `transport rpc`, including the "Consuming streams" section this guide's `runtime.stream(...)` example links back to
- [Transport Architecture](/architecture/transport-architecture)
