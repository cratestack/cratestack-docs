---
title: Pagination
description: Offset-based pagination via `@@paged` — a stable `Page<T>` envelope with `totalCount` and `pageInfo`, identical across REST and RPC.
---

# Pagination

A plain generated list route returns every row the caller's read policy
admits, as a bare array. That's fine for small, bounded collections (an
account's linked cards, a customer's addresses) but wrong for anything
that grows without bound — transaction history, audit trails, anything
paginated in a real UI. `@@paged` opts a model's list route into a
stable, offset-based paging envelope instead.

## Schema attribute

```cstack
model Transaction {
  id Cuid @id
  accountId Int
  amount Decimal
  postedAt DateTime

  @@paged
  @@allow("read", auth() != null)
}
```

Constraints enforced at parse time:

1. `@@paged` must be bare — `@@paged(mode: "offset")` or any other
   argument form fails validation with "use bare `@@paged` in this
   slice." Cursor-based paging isn't implemented; this reads as a
   placeholder for a future mode, not a currently-selectable option.
2. one model can declare it at most once.

There's no accompanying field to add — unlike `@@soft_delete` (which
needs a `deletedAt DateTime?` column), `@@paged` only changes how the
list *route* behaves. The underlying table is unaffected.

## Query contract

The generated list route accepts `limit` and `offset` as ordinary query
parameters, on top of the usual `fields` / `include` / `sort` / `where`
contract every list route already has:

```
GET /transactions?limit=20&offset=40&sort=-postedAt
```

- both are optional `Int`s; a non-numeric value or a negative value is
  a `400` naming the specific problem
- **`limit` is capped at `MAX_LIST_LIMIT` (1000), and omitting it is
  not "no limit."** An explicit `limit` above the cap is a `400`.
  Omitting `limit` entirely defaults it to the cap — it does *not*
  fall through to an unbounded fetch, so `GET /transactions` with no
  `limit` at all still only returns (at most) the first 1000 rows
  matching the read policy and any `where` filter
- `offset` defaults to `0` when omitted
- **`MAX_LIST_LIMIT` is a hard ceiling, not per-model configurable.**
  Every generated list route enforces the same constant
  (`cratestack_core::page::MAX_LIST_LIMIT`, currently `1000`),
  regardless of whether the model is `@@paged` — a non-paged model's
  list route caps an omitted or over-limit `limit` exactly the same
  way. There is no schema-level override today; if your use case
  genuinely needs a different ceiling, that's a framework-level
  change, not something you can raise per model.

RPC transport takes the same two keys in the unary call's input object
(`{"limit": 20, "offset": 40}` for `model.Transaction.list`) — the
server synthesizes the equivalent query string internally and runs the
identical list path, so the envelope below is transport-independent.

## Response envelope

```jsonc
{
  "items": [ /* Transaction[] */ ],
  "totalCount": 1284,
  "pageInfo": {
    "limit": 20,
    "offset": 40,
    "hasNextPage": true,
    "hasPreviousPage": true
  }
}
```

Canonical shape: `cratestack_core::page::{Page, PageInfo}`.

- `totalCount` — total rows matching the read policy and any `where`
  filter, ignoring `limit`/`offset`. Computed by re-running the same
  filtered `FindMany` query with no `limit`/`offset` and taking the
  length of the resulting row set — **not** a lightweight SQL
  `COUNT(*)`. The second query fetches and deserializes every matching
  row, so a paged list costs two round trips to the database and the
  second one scales with the total match count, not one cheap count
  plus one page.
- `pageInfo.limit` — the limit actually applied, including the
  `MAX_LIST_LIMIT` default when the request omitted it (never `null`)
- `pageInfo.offset` — echoes exactly what the request supplied
- `pageInfo.hasNextPage` — `offset + limit < totalCount`
- `pageInfo.hasPreviousPage` — `offset > 0`

A non-`@@paged` model's list route is unaffected under REST and RPC — it
keeps returning a bare array, and `limit`/`offset` have no special
handling for it. **`transport grpc` schemas are the exception:** every
model's `list` op returns `Page<Model>` under gRPC regardless of
whether `@@paged` is declared — `@@paged` there only gates REST/RPC
envelope shape, not a semantic switch a gRPC schema can opt out of.

## Generated clients

Every generated client (Rust, Dart, TypeScript) exposes the same
envelope; `Page<T>` in each is a hardcoded mirror of the struct above,
not an independently-designed type — field names differ only by each
language's own casing convention (`totalCount`/`total_count`,
`hasNextPage`, etc.), never in shape.

Rust (generated HTTP client — `client::Client`, accessors are
pluralized like every other generated client; the server-side direct
`Cratestack` accessor used inside your own procedure handlers is
singular instead, e.g. `cool.transaction()`, not `cool.transactions()`):

```rust
let page = client.transactions().list(&[("limit", "20")], &[]).await?;
println!("{} of {}", page.items.len(), page.total_count.unwrap_or(0));
println!("more? {}", page.page_info.has_next_page);
```

TypeScript:

```ts
const page = await client.transactions.list({ query: { limit: 20, offset: 40 } });
console.log(page.items.length, page.totalCount, page.pageInfo.hasNextPage);
```

Dart:

```dart
final page = await client.transactions.list(
  query: selection.toListQuery(limit: 20, offset: 40),
);
print('${page.items.length} of ${page.totalCount}, hasNext=${page.pageInfo.hasNextPage}');
```

Rust and Dart also generate a projection-aware `list_view(...)` /
`listView(...)` alongside `list(...)`: same `Page<T>` envelope, just
with `T` narrowed to the projected shape instead of the full model.
The generated TypeScript client doesn't have a projection-view API
today — only `list(...)` returning `Page<Model>`. See
[Client Runtime](/architecture/client-runtime) for the full
Rust/Dart selection/projection API this composes with.

## Procedure Arguments: PageInput

`@@paged` only affects a model's generated `list` route. A custom
**procedure** that wants the same `limit`/`offset` capability declares a
`PageInput` argument instead:

```cstack
procedure listFeed(page: PageInput): FeedReply
```

`PageInput` is `{ limit: Int?, offset: Int? }` — field names and
optionality match `PageInfo`'s own `limit`/`offset` exactly, so a
generated `list` route and a hand-written `PageInput`-accepting
procedure decode the same wire shape:

```jsonc
// POST /$procs/listFeed
{ "page": { "limit": 20, "offset": 40 } }
```

Resolve it into concrete, safe values with `.resolve(max_limit)` —
`limit` defaults to `max_limit` when unset and is clamped to `[0,
max_limit]`; `offset` defaults to `0` and is clamped to `>= 0`. This is
the same clamp rule generated `list` routes already apply to their own
`limit`/`offset`, so a `PageInput`-accepting procedure gets the
identical resource-exhaustion guard without reimplementing it:

```rust
impl cratestack_schema::procedures::ProcedureRegistry for Procedures {
    async fn list_feed(
        &self,
        _db: &cratestack_schema::Cratestack,
        _ctx: &CratestackContext,
        args: cratestack_schema::procedures::list_feed::Args,
    ) -> Result<cratestack_schema::procedures::list_feed::Output, CratestackError> {
        let (limit, offset) = args.page.resolve(50);
        // ... use limit/offset to build your own response
        Ok(cratestack_schema::FeedReply { limit, offset })
    }
}
```

`PageInput` doesn't return a `Page<T>` by itself — the procedure's
return type is whatever it's declared as. Pair `page: PageInput` with a
`Page<Model>` return type to give the procedure the exact same envelope
a `@@paged` list route returns:

```cstack
procedure searchPosts(query: FindMany<Post>, page: PageInput): Page<Post>
```

See [Search with Filters](./find-many) for the full worked example —
`FindMany<Model>`'s own headline use case composes with `PageInput`
exactly this way.

Generated clients mirror `PageInput` the same way they mirror
`PageInfo`/`Page<T>` — a hardcoded, per-language struct/interface/class,
not derived per schema:

```rust
// Rust
cratestack_schema::procedures::list_feed::Args {
    page: cratestack::PageInput { limit: Some(20), offset: Some(40) },
}
```

```ts
// TypeScript
await client.procedures.listFeed({ page: { limit: 20, offset: 40 } });
```

```dart
// Dart
await client.procedures.listFeed(
  const ListFeedArgs(page: PageInput(limit: 20, offset: 40)),
);
```

## Embedded (on-device) pagination

Everything above describes the REST/RPC/gRPC server surface, but pagination
isn't limited to it. Every embedded (`cratestack-rusqlite`) model **and
view** delegate exposes `.find_many(...).paginate(page: PageInput) ->
Page<M>` unconditionally — `@@paged` is neither rejected nor required on
an embedded schema; the method is just always there.

```rust
let page = delegate
    .find_many()
    .paginate(PageInput { limit: Some(20), offset: Some(40) })?;
println!("{} of {}", page.items.len(), page.total_count.unwrap_or(0));
```

This isn't a cheap approximation: it runs a real `COUNT(*)` over the same
filters followed by the paginated `SELECT`, both inside one connection
borrow so a concurrent write can't split what the count describes from
the page it's paired with — the same `Page<M>` / `PageInfo` shape the
server-side envelope uses, assembled locally instead of over the wire.
Unlike the server path, there's no separate wire contract to fix per
model here, so there's nothing for `@@paged` to gate: the caller is the
same binary that defines the schema, choosing per call site whether it
wants `Page<M>` (`.paginate(...)`) or a bare `Vec<M>` (`.run()`).

## What this is not

1. **not cursor-based** — no opaque cursor token, no keyset pagination.
   `offset` on a table that's being written to concurrently can skip or
   repeat rows across page fetches, same as any offset-based scheme.
2. **not a per-model-tunable size limit** — `MAX_LIST_LIMIT` rejects
   pathological requests, but it's one fixed constant for the whole
   framework. It's a safety ceiling, not a page-size policy you can set
   per model or per caller — build that on top if you need it.
3. **not free** — every paged fetch is two queries (list + count), not
   one. A model that's always fetched in full (small reference tables)
   doesn't want `@@paged`.
4. **not required for bounded relations** — a to-many relation you
   always fetch completely (a currency's denominations, a country's
   provinces) should stay a plain list.

## When to use it

Apply `@@paged` to any model whose list route can return an unbounded
or large number of rows: transaction/ledger history, audit-adjacent
event logs, anything a real UI paginates or infinite-scrolls. Skip it
for small, bounded collections where "just return everything" is
simpler for every caller.

## Read Next

1. [Client Runtime](/architecture/client-runtime) — how `Page<T>` composes with selection/projection builders across generated clients
2. [Field Attributes](/reference/field-attributes) — where `@@paged` sits alongside the other model-level attributes
