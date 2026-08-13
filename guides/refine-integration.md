---
title: refine.dev integration
description: Wire a refine.dev dataProvider by hand to a cratestack-generated TypeScript REST client — pagination, filters, sorting, optimistic-locking conflicts, primary keys, and procedures — plus the gaps that aren't wired today.
---

# refine.dev integration

[refine](https://refine.dev) is a React meta-framework for admin panels and
internal tools, built around a `DataProvider` interface: one small object
with a fixed set of methods (`getList`, `getOne`, `create`, `update`,
`deleteOne`, …) that every refine hook and component calls through instead
of talking to your API directly.

<Note>
**Most readers want [`@cratestack/refine`](https://www.npmjs.com/package/@cratestack/refine) instead of this guide.**
It ships a tested `DataProvider` for both transports —
`createCratestackDataProvider` (REST) and `createCratestackRpcDataProvider`
(RPC) — covering everything below: pagination, the filter-operator
mapping, non-`id` primary keys, `@version` optimistic locking, and bulk
operations. Pair it with `generate-typescript --refine`, which emits the
resource manifest for your schema, and you write no dataProvider code at
all.

This guide is the **hand-wired** version of the same thing. Read it when
you need to understand what the package does under the hood, or when you
want to adapt the approach rather than take the dependency.
</Note>

Every method name, type, and request shape below is checked against the
real generated client and server.

This guide covers REST-transport schemas only (`generate-typescript`'s
default transport). RPC-transport clients expose an equivalent per-model
API (see [TypeScript client generation](./typescript-client-generation)),
but the query-string filter convention this guide's `getList` relies on
is REST-specific — an RPC dataProvider needs its own filter-mapping layer
and isn't covered here.

## Prerequisites

Before wiring a resource, check three things against its `.cstack` model:

| refine needs | cratestack requires |
|---|---|
| `total` in every `getList` response | `@@paged` on the model — see [Pagination requirement](#pagination-requirement) below |
| a stable `id` per record | any field name, mapped via `primaryKey` in your resource config — see [Primary keys](#primary-keys) |
| conflict-safe `update`/`deleteOne` | `@version` on the model, threaded through `If-Match` — see [Optimistic locking](#optimistic-locking-the-crux) |

Generate the client the usual way:

```bash
cargo run -p cratestack-cli -- generate-typescript \
  --schema schema.cstack \
  --out packages/api-client \
  --package-name @example/api-client \
  --base-path /api
```

The examples below use a `Widget` model (plain CRUD) and a `Ledger` model
(`@@paged`, `@version`) to show both the simple and the crux-of-this-guide
cases:

```cstack
model Widget {
  id Int @id
  name String
  weight Int?

  @@allow("read", auth() != null)
  @@allow("create", auth() != null)
  @@allow("update", auth() != null)
  @@allow("delete", auth() != null)
}

model Ledger {
  id Int @id
  label String
  balance Int
  version Int @version

  @@paged
  @@allow("read", auth() != null)
  @@allow("update", auth() != null)
  @@allow("delete", auth() != null)
}
```

## The shape of the problem

A generated model API class (`client.widgets`, `client.ledgers`, …) has
`list`/`get`/`create`/`update`/`delete` — see
[Using the REST client](./typescript-client-generation#using-the-rest-client)
for the full generated surface. refine's `DataProvider` interface is
shaped similarly but not identically: different method names, a
pagination/filter/sort object instead of a query string, and an `id`
field it assumes every record has. The dataProvider below is the
adapter layer between the two.

Structural note: each generated model class (`WidgetApi`, `LedgerApi`,
…) is its own concrete TypeScript class, not an implementation of a
shared interface the package exports — there's no generated common type
to write one generic dataProvider function against across every
resource. The `ModelApi` interface below is hand-written to match the
real generated shape closely enough to type-check against it; loosen or
drop it if your `tsconfig` is stricter than this guide's example. This
exact gap — one dataProvider per app instead of one per framework — is
what `@cratestack/refine` closes generically; this section is what it does
for you.

```ts
import type { CratestackFetchQuery, CratestackRequestConfig, Page } from "@example/api-client";
import type {
  DataProvider,
  GetListParams, GetListResponse,
  GetOneParams, GetOneResponse,
  GetManyParams, GetManyResponse,
  CreateParams, CreateResponse,
  UpdateParams, UpdateResponse,
  DeleteOneParams, DeleteOneResponse,
  CustomParams, CustomResponse,
  CrudFilters, CrudSorting, HttpError,
} from "@refinedev/core";

interface ModelApi<TModel, TCreateInput, TUpdateInput> {
  list(options?: { query?: CratestackFetchQuery; headers?: HeadersInit }): Promise<TModel[] | Page<TModel>>;
  get(id: any, options?: { query?: CratestackFetchQuery; headers?: HeadersInit }): Promise<TModel>;
  create?(input: TCreateInput, options?: CratestackRequestConfig): Promise<TModel>;
  update(id: any, input: TUpdateInput, options?: CratestackRequestConfig): Promise<TModel>;
  delete(id: any, options?: CratestackRequestConfig): Promise<void>;
}

interface ResourceConfig<TModel = any, TCreateInput = any, TUpdateInput = any> {
  api: ModelApi<TModel, TCreateInput, TUpdateInput>;
  /** The schema's `@id` field name — refine assumes `id`; cratestack doesn't. */
  primaryKey: string;
  /** Mirrors whether the model declares `@@paged`. */
  paged: boolean;
  /** Mirrors whether the model declares `@version`, and which field it's on. */
  versionField?: string;
}
```

There's no runtime introspection endpoint that hands back "which models
are `@@paged`, which have `@version`, what's the primary key field" — the
generated client carries no such metadata object. Those facts live in the
`.cstack` schema and in the generated client's TypeScript *types*, and
nowhere else at runtime, so `ResourceConfig` has to be written down
somewhere.

**Let the generator write it.** Pass `--refine` to
`cratestack generate-typescript` and it emits an extra `src/refine.ts`
alongside the client, holding exactly this map:

```bash
cratestack generate-typescript \
  --schema schema.cstack \
  --out packages/api-client \
  --refine
```

```ts
import { ExampleApiClientClient } from "@example/api-client";
import { cratestackRefineResources } from "@example/api-client/refine";

const client = new ExampleApiClientClient("https://api.example.com", {
  basePath: "/api",
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
});

const resources = cratestackRefineResources(client);
```

`--refine` is additive: every other generated file is byte-identical with
and without it. It requires a REST schema and the default preset — the
RPC and gRPC-Web clients don't share the REST client's `list(options)` /
`CratestackFetchQuery` shape, and the `/swr` layout emits free functions
rather than a client class for a resource to bind to.

Writing the map by hand stays fully supported — it is a plain object
literal, and it's what the generated file contains:

```ts
const resources: Record<string, ResourceConfig> = {
  widgets: { api: client.widgets, primaryKey: "id", paged: false },
  ledgers: { api: client.ledgers, primaryKey: "id", paged: true, versionField: "version" },
};
```

The difference is drift. A model that later gains `@version`, or one
whose `@id` isn't called `id`, updates itself on the next
`generate-typescript` run; the hand-written copy doesn't, and gets it
wrong silently — a stale `versionField` means writes stop sending
`If-Match` and lose optimistic-locking, with no error anywhere.

## Pagination

refine's `Pagination` is `{ currentPage?: number; pageSize?: number; mode?:
"client" | "server" | "off" }` as of `@refinedev/core` v5 (what `npm
install @refinedev/core` gives you today — verified against the
package's own shipped `.d.ts`). **If your project is still on the v4
major, the same field is named `current` instead** — v5 renamed
`current` → `currentPage`; nothing else about this section changes
between the two. cratestack's list route takes `limit`/`offset` and,
only for a `@@paged` model, returns `totalCount` alongside the items
(`Page<T> { items, totalCount, pageInfo }`, mirroring
`cratestack_core::page::{Page, PageInfo}` — `crates/cratestack-client-typescript/templates/src/models.ts.j2`). The mapping:

```
limit  = pageSize
offset = (currentPage - 1) * pageSize
total  = page.totalCount   // refine's GetListResponse.total
```

### Pagination requirement

**A resource's model must declare `@@paged`, or refine's pagination
controls silently lie.** `totalCount` is only ever computed and emitted
for a `@@paged` model's list route — the token-generation gate is
literally `if !paged { return quote!{}; }` for the total-count query
(`crates/cratestack-macros/src/axum/model/prep/list_logging.rs`).
A non-`@@paged` model's `list()` returns a bare `Widget[]`, no
`totalCount` at all, and (this is the trap) `limit`/`offset` still work
on it — every list route enforces the same `MAX_LIST_LIMIT` regardless
of `@@paged` (see [Pagination](./pagination)). So a non-paged resource
wired into `getList` naively will fetch a real page 2, get back 10 rows,
report `total: 10` because that's all you have to count, and refine's
pagination UI will conclude there's no page 3 — even though there is
one. Either add `@@paged` to the model, or configure that refine
resource with `pagination: { mode: "off" }` and treat the (capped, up
to `MAX_LIST_LIMIT`) full array as one page. Don't wire page controls to
a non-`@@paged` resource and assume `total` is trustworthy — it isn't.

```ts
async function getList({ resource, pagination, sorters, filters }: GetListParams): Promise<GetListResponse> {
  const config = resources[resource];
  if (!config) throw new Error(`no cratestack resource configured for "${resource}"`);

  const usePaging = config.paged && pagination?.mode !== "off";
  const currentPage = pagination?.currentPage ?? 1; // v4: pagination?.current
  const pageSize = pagination?.pageSize ?? 10;

  const query: CratestackFetchQuery = {
    sort: toSortQuery(sorters),
    filters: toQueryFilters(filters),
    ...(usePaging ? { limit: pageSize, offset: (currentPage - 1) * pageSize } : {}),
  };

  const result = await config.api.list({ query });

  if (config.paged) {
    const page = result as Page<any>;
    return {
      data: page.items.map((item) => withRefineId(item, config.primaryKey)),
      total: page.totalCount ?? page.items.length,
    };
  }

  const items = result as any[];
  return { data: items.map((item) => withRefineId(item, config.primaryKey)), total: items.length };
}
```

## Filters

refine's filter operators map onto the generated list route's
`field__operator=value` query convention almost one to one — this is
the *same* operator set the generated TypeScript client's shared filter
interfaces expose (`EqualityFilter<V> { eq, ne, in, isNull }`,
`ComparableFilter<V> extends EqualityFilter<V> { lt, lte, gt, gte }`,
`StringFilter extends ComparableFilter<string> { contains, startsWith }`
— `crates/cratestack-client-typescript/templates/src/models.ts.j2`),
because both are generated from the same per-field arm table
(`crates/cratestack-macros/src/axum/filter_arms.rs::generate_query_filter_arm`).
A bare `field=value` query param means `eq`; every other operator is
`field__<operator>=value`:

| refine operator | cratestack query key | Notes |
|---|---|---|
| `eq` | `field` (no suffix) | |
| `ne` | `field__ne` | |
| `in` | `field__in` | comma-separated values |
| `lt` / `lte` / `gt` / `gte` | `field__lt` / `__lte` / `__gt` / `__gte` | numeric/date/decimal/string-orderable fields only |
| `contains` | `field__contains` | `String`/`Cuid` fields only |
| `startswith` | `field__startsWith` | `String`/`Cuid` fields only, note the camelCase suffix |
| `null` | `field__isNull=true` | optional fields only |
| `nnull` | `field__isNull=false` | optional fields only |

**Caveat that's easy to miss: `eq`/`ne`/`in`/`lt`/`lte`/`gt`/`gte` are
only wired for *required* (non-nullable) fields.** A nullable field
(`weight Int?`) only ever gets `contains`/`startsWith` (if it's a string)
and `isNull` — the codegen arm for the comparison/equality operators is
gated on `field.ty.arity == TypeArity::Required`
(`crates/cratestack-macros/src/axum/filter_arms.rs`). Filtering a
nullable field by exact value needs a workaround on your side (a
generated column, a `NOT NULL` companion field) — there's no server-side
operator for it today.

**refine operators with no cratestack equivalent must fail loudly, not
silently drop the filter.** `endswith`, `between`, `nin`, `containss`
(and every other operator/combinator not in the table above, including
refine's `or`/`and` conditional-filter groups — the query convention
here is a flat AND of per-field predicates only) have no server-side
translation. Silently dropping one of these would make the UI show an
unfiltered result set as if it were filtered — worse than an error,
because nothing signals the data is wrong:

```ts
const SUPPORTED_OPERATOR_SUFFIX: Record<string, string | null> = {
  eq: null,
  ne: "ne",
  in: "in",
  lt: "lt",
  lte: "lte",
  gt: "gt",
  gte: "gte",
  contains: "contains",
  startswith: "startsWith",
  null: "isNull",
  nnull: "isNull",
};

function toQueryFilters(filters: CrudFilters = []): Record<string, string> {
  const output: Record<string, string> = {};
  for (const filter of filters) {
    if (!("field" in filter)) {
      throw new Error(
        `refine "${filter.operator}" filter groups have no cratestack equivalent — ` +
          `this dataProvider only supports a flat AND of per-field predicates`,
      );
    }
    if (!(filter.operator in SUPPORTED_OPERATOR_SUFFIX)) {
      throw new Error(
        `refine operator "${filter.operator}" on "${filter.field}" has no cratestack equivalent ` +
          `(supported: ${Object.keys(SUPPORTED_OPERATOR_SUFFIX).join(", ")}) — ` +
          `failing loudly instead of silently returning unfiltered data`,
      );
    }
    const suffix = SUPPORTED_OPERATOR_SUFFIX[filter.operator];
    const key = suffix ? `${filter.field}__${suffix}` : filter.field;
    output[key] = toFilterValue(filter.operator, filter.value);
  }
  return output;
}

function toFilterValue(operator: string, value: unknown): string {
  if (operator === "null") return "true";
  if (operator === "nnull") return "false";
  if (Array.isArray(value)) return value.map(String).join(",");
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toSortQuery(sorters: CrudSorting = []): string[] | undefined {
  if (sorters.length === 0) return undefined;
  return sorters.map((s) => (s.order === "desc" ? `-${s.field}` : s.field));
}
```

If you need `contains`/`startsWith`/comparison filtering across a field
combination this convention can't express — an OR group, a nullable
field's exact-match filter — cratestack's typed `FindMany<Model>`
argument (`<Model>Where`/`<Model>FindMany`, the same
`EqualityFilter`/`ComparableFilter`/`StringFilter` shapes as a structured
JSON body instead of query-string suffixes) is a **procedure-only**
mechanism, not something the plain `list()` route accepts — see
[Search with Filters](./find-many). Wiring refine to a `FindMany<Model>`-backed
procedure instead of the plain list route is a legitimate escape hatch,
but it's a different `getList` implementation (calling
`client.procedures.searchX(...)` instead of `client.x.list(...)`), not
covered further here.

## Primary keys

refine assumes every record has an `id: BaseKey` (`string | number`).
cratestack's `@id` can be on any field, any scalar type. Mapping is
one direction on read, the identity function on write, because the
*value space* is the same — only the property name differs:

- **Read (cratestack → refine):** attach a synthetic `id` alongside the
  real field, so refine's row-selection/detail-view machinery has
  something to key off:

  ```ts
  function withRefineId<T extends Record<string, any>>(record: T, primaryKey: string) {
    return { ...record, id: record[primaryKey] };
  }
  ```

- **Write (refine → cratestack):** `getOne`/`update`/`deleteOne` all
  receive refine's synthesized `id`, which is exactly the primary key's
  *value* — pass it straight through as the `id` argument to `.get()`/
  `.update()`/`.delete()`, no translation needed:

  ```ts
  await config.api.get(id);            // id === record[primaryKey]'s value
  await config.api.update(id, input);
  ```

  The one place this bites: a `<Create>` form's fields must be named
  after the schema's *real* primary-key field (`sku`, not `id`) — the
  synthetic `id` only exists on records that already came back from the
  server; a create payload has no record yet to synthesize it from.

## Optimistic locking (the crux)

**This is the single most important correctness point in this guide.**
A `@version` model requires `If-Match` on both `PATCH` (update) *and*
`DELETE` — cratestack#519, closed by cratestack#538, which landed the
delete-side enforcement `delete_if_match_decl`/`delete_if_match_apply`
deliberately mirroring the update path token-for-token
(`crates/cratestack-macros/src/axum/model/prep/etag.rs`). Missing or
stale `If-Match` on either verb returns `412 Precondition Failed` and
leaves the row untouched. See [Optimistic Locking](./optimistic-locking)
for the full contract (`ETag`/`If-Match` format is a quoted integer,
e.g. `If-Match: "3"` — `crates/cratestack-axum/src/headers/etag.rs`).

refine's `update`/`deleteOne` hooks fetch the record before editing it
(`useOne`/`useShow` populate the edit form; a list/detail view is
usually on screen before a delete button is clicked), so the version is
available by the time a mutation fires — it just isn't part of refine's
`UpdateParams`/`DeleteOneParams` by default. Thread it through a small
version cache the dataProvider maintains itself, populated by every read
and write that returns a fresh record:

```ts
const versionCache = new Map<string, number>();
const versionKey = (resource: string, id: unknown) => `${resource}:${id}`;

function rememberVersion(resource: string, id: unknown, record: Record<string, any>, config: ResourceConfig) {
  if (!config.versionField) return;
  const version = record[config.versionField];
  if (typeof version === "number") versionCache.set(versionKey(resource, id), version);
}

function ifMatchHeaders(resource: string, id: unknown, config: ResourceConfig, override?: number): HeadersInit {
  if (!config.versionField) return {};
  const version = override ?? versionCache.get(versionKey(resource, id));
  if (version === undefined) {
    throw new Error(
      `no known version for ${resource}/${id} — call getOne (or getList) before update/delete on a ` +
        `@version model, or pass meta: { ifMatch: <version> } explicitly`,
    );
  }
  return { "If-Match": `"${version}"` };
}
```

Wired into `update`/`deleteOne`, with a `412` surfaced as a real,
distinguishable conflict rather than a generic failure:

```ts
async function update({ resource, id, variables, meta }: UpdateParams): Promise<UpdateResponse> {
  const config = resources[resource];
  const headers = ifMatchHeaders(resource, id, config, meta?.ifMatch as number | undefined);
  try {
    const record = await config.api.update(id, variables, { headers });
    rememberVersion(resource, id, record, config);
    return { data: withRefineId(record, config.primaryKey) };
  } catch (error) {
    throw toRefineError(error);
  }
}

async function deleteOne({ resource, id, meta }: DeleteOneParams): Promise<DeleteOneResponse> {
  const config = resources[resource];
  const headers = ifMatchHeaders(resource, id, config, meta?.ifMatch as number | undefined);
  try {
    await config.api.delete(id, { headers });
    return { data: { id } };
  } catch (error) {
    throw toRefineError(error);
  } finally {
    versionCache.delete(versionKey(resource, id));
  }
}

function toRefineError(error: unknown): HttpError {
  if (error instanceof CratestackHttpError) {
    if (error.status === 412) {
      return {
        message: "This record changed since it was loaded. Reload it and try again.",
        statusCode: 412,
      };
    }
    const payload = error.payload as { message?: string } | undefined;
    return { message: payload?.message ?? error.message, statusCode: error.status };
  }
  return { message: error instanceof Error ? error.message : "Unknown error", statusCode: 500 };
}
```

`CratestackHttpError` (`status`, `response`, `payload`) is generated
into `runtime.ts` and re-exported from the package root
(`crates/cratestack-client-typescript/templates/src/rest-runtime.ts.j2`).
`412`'s response body is the standard `CoolErrorResponse { code:
"PRECONDITION_FAILED", message, details }` envelope
(`crates/cratestack-core/src/error.rs`) — checking `error.status === 412`
rather than pattern-matching `payload.code` is the more robust test,
since the status is set unconditionally by the runtime's `!response.ok`
branch regardless of codec.

`create` and `getOne`/`getList`/`getMany` should also call
`rememberVersion` on their own responses, so a versioned resource's
cache stays populated after every round trip, not just after an update:

```ts
async function getOne({ resource, id }: GetOneParams): Promise<GetOneResponse> {
  const config = resources[resource];
  const record = await config.api.get(id);
  rememberVersion(resource, id, record, config);
  return { data: withRefineId(record, config.primaryKey) };
}
```

## getMany

`getMany` is optional on `DataProvider` — refine falls back to it only
if you implement it. Because the `in` operator from the [filters
table](#filters) applies to any required field, including the primary
key, `getMany` is a single `list()` call rather than N `getOne` calls:

```ts
async function getMany({ resource, ids }: GetManyParams): Promise<GetManyResponse> {
  const config = resources[resource];
  const query: CratestackFetchQuery = {
    filters: { [`${config.primaryKey}__in`]: ids.map(String).join(",") },
  };
  const result = await config.api.list({ query });
  const items = config.paged ? (result as Page<any>).items : (result as any[]);
  items.forEach((item) => rememberVersion(resource, item[config.primaryKey], item, config));
  return { data: items.map((item) => withRefineId(item, config.primaryKey)) };
}
```

## `create`

```ts
async function create({ resource, variables }: CreateParams): Promise<CreateResponse> {
  const config = resources[resource];
  if (!config.api.create) {
    throw new Error(
      `"${resource}" has no generated create route — its model declares no ` +
        `@@allow("create", ...) policy`,
    );
  }
  const record = await config.api.create(variables);
  rememberVersion(resource, record[config.primaryKey], record, config);
  return { data: withRefineId(record, config.primaryKey) };
}
```

`config.api.create` is only present on the generated class in the first
place when the model declares a create policy — see
[Policy-denied operations](#gaps-honest-limitations) below for the case
where the method exists but a *particular caller* still can't use it.

## Procedures as `custom`

A cratestack `procedure` call has no other home in a `DataProvider` —
map refine's `custom` onto `client.procedures.<name>(...)`, using
`meta.procedure` to name which one:

```ts
async function custom({ payload, meta }: CustomParams): Promise<CustomResponse> {
  const procedureName = meta?.procedure as string | undefined;
  const procedureFn = procedureName ? (client.procedures as Record<string, unknown>)[procedureName] : undefined;
  if (typeof procedureFn !== "function") {
    throw new Error(`custom() needs meta: { procedure: "<name>" } naming a generated procedures.* method`);
  }
  const data = await (procedureFn as (args: unknown) => Promise<unknown>)(payload ?? {});
  return { data };
}
```

Called with the procedure's own declared argument shape as `payload` —
`publishPost(args: PublishPostInput)` generates `PublishPostArgs { args:
PublishPostInput }`
([TypeScript client generation § Procedures](./typescript-client-generation#procedures)),
so:

```ts
await dataProvider.custom({
  url: "",
  method: "post",
  meta: { procedure: "publishPost" },
  payload: { args: { postId: 1 } },
});
```

## Gaps: honest limitations

Three things a refine app might reach for that aren't wired today —
stated plainly rather than hand-waved:

**No `liveProvider` — the generated TypeScript client has no SSE
consumer.** The server has a real SSE subscription surface (`GET
/rpc/subscribe/{op_id}`,
`crates/cratestack-macros/src/include/server/rpc_module/subscribe.rs`,
exercised end-to-end by
`crates/cratestack-pg/tests/rpc_subscribe_sse.rs`), but the TypeScript
client templates contain no `EventSource`/`text/event-stream` consumer
anywhere in `crates/cratestack-client-typescript/templates/` — a
`grep` for `EventSource`/`text/event-stream` across that whole directory
comes back empty. refine's `liveProvider` (real-time list/detail
updates via a subscription) is **not wireable today** against a
generated TypeScript client. Poll instead (`refetchInterval` on the
relevant query), or hand-roll an `EventSource` against the RPC
subscribe endpoint yourself if a schema uses `transport rpc`.

**Bulk operations aren't exposed on the generated client.**
`update_many`/`delete_many` exist server-side
(`crates/cratestack-sqlx/src/delegate/model.rs`), and `POST /rpc/batch`
exists for RPC-transport schemas, but the REST client's per-model class
only ever generates `list`/`get`/`create`/`update`/`delete` — no
`updateMany`/`deleteMany` wrapper, and the RPC dispatch table's op verbs
are hardcoded to `["list", "get", "create", "update", "delete"]`
(`crates/cratestack-macros/src/transport/rpc.rs`). refine's
`createMany`/`updateMany`/`deleteMany` are optional on `DataProvider` —
leave them unimplemented (refine falls back to sequential single-record
calls in the hooks that need them, at the cost of N round trips instead
of one, and no cross-record atomicity), or implement them yourself as
`Promise.all(...)` over the single-record methods with the same caveat.

**Policy-denied operations still generate a working-looking client
method.** Route suppression — hiding a client method entirely when a
caller's policy can never satisfy it — is a designed-but-unimplemented
feature: `docs/design/route-suppression.md` is explicit that
cratestack#514 is a spike only ("**Not implemented. No implementation
may merge under #514**"). What actually gates a generated `create()`
method's presence is only whether the model declares *any*
`@@allow("create", ...)` at all
(`crates/cratestack-client-typescript/src/types.rs::model_allows_create`)
— not whether the predicate can ever evaluate `true` for the caller in
question. A model with `@@allow("create", auth().role == "admin")` still
gets a `.create()` method on the generated client for every caller, and
a refine `<Create>` button wired to that resource will render for a
non-admin user and fail with `403` the moment they submit. Until route
suppression ships, declare such resources with `create: false`/`edit:
false`/`delete: false` (whichever verbs your policy actually denies) in
refine's `resources` config for the caller roles that can't use them —
don't rely on the generated client's method presence as a proxy for
"the current caller is allowed to do this."

## Full example

Everything above assembled into one `dataProvider`:

```ts
import type { DataProvider } from "@refinedev/core";
import {
  ExampleApiClientClient,
  CratestackHttpError,
  type CratestackFetchQuery,
  type Page,
} from "@example/api-client";

const client = new ExampleApiClientClient("https://api.example.com", { basePath: "/api" });

const resources: Record<string, ResourceConfig> = {
  widgets: { api: client.widgets, primaryKey: "id", paged: false },
  ledgers: { api: client.ledgers, primaryKey: "id", paged: true, versionField: "version" },
};

export const cratestackDataProvider: DataProvider = {
  getApiUrl: () => `${client.runtime.origin}${client.runtime.basePath === "/" ? "" : client.runtime.basePath}`,
  getList,
  getOne,
  getMany,
  create,
  update,
  deleteOne,
  custom,
};
```

(`getList`, `getOne`, `getMany`, `create`, `update`, `deleteOne`,
`custom`, `withRefineId`, `toQueryFilters`, `toSortQuery`,
`rememberVersion`, `ifMatchHeaders`, `toRefineError` are the functions
defined section by section above — assemble them into one module in
that order.)

## See also

1. [`@cratestack/refine`](https://www.npmjs.com/package/@cratestack/refine) — the packaged version of this entire guide, for both REST and RPC schemas
2. [TypeScript client generation](./typescript-client-generation) — the generated client surface this guide adapts, including `--refine`
3. [Optimistic Locking](./optimistic-locking) — the full `@version`/`If-Match`/`ETag` contract
4. [Pagination](./pagination) — `@@paged`, `Page<T>`, `MAX_LIST_LIMIT`
5. [Search with Filters — `FindMany<Model>`](./find-many) — the typed, procedure-only filter argument for cases the query-string convention can't express
6. [RPC transport](./rpc-transport) — if your schema uses `transport rpc` instead of REST
