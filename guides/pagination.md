---
title: Pagination
description: Offset and cursor (keyset) pagination via `@@paged` — a stable `Page<T>` envelope with `totalCount` and `pageInfo`, `?cursor=` for append-only tables, CursorPageInput and CursorPage<T> for procedures, identical across REST and RPC.
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
   slice." There is no `mode` argument: cursor paging is not a second
   `@@paged` mode, it is a query parameter on the same model (see
   [Cursor pagination](#cursor-pagination)).
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
  filter, ignoring `limit`/`offset`. A relation filter in that `where`
  applies the related model's read policy and `@@soft_delete` filter
  *(since 0.13.0)*, for the count as for the items. Before 0.13.0 both
  could be used to probe related rows the caller could not read (see
  [Relation filters and sorts](../reference/auth-support-matrix#relation-filters-and-sorts)). Computed by re-running the same
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
handling for it. REST and RPC are the only two transports, so this rule
has no exceptions.

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

Everything above describes the REST/RPC server surface, but pagination
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

## Cursor pagination

*(since 0.19.4, cratestack#1304)* Offset paging over a table that is being
written to skips or repeats rows when an insert lands between two page
fetches. Cursor (keyset) paging does not: each page is "the rows strictly
after the last row of the previous page", so a row inserted before the
cursor never shifts what comes next. It is additive: `limit`/`offset`,
`Page<T>` and `PageInput` are unchanged.

**Choose cursor over offset** for append-only or live tables (ledgers,
transaction history, feeds, audit trails) and for infinite scroll. **Keep
offset** when the UI needs "jump to page N" or a random-access page number.

### List routes

`GET /<plural>?cursor=` on a `@@paged` model opts in. An empty value
(`?cursor=`) is the first page; a previous response's `pageInfo.nextCursor`
continues:

```
GET /transactions?cursor=&limit=20&sort=-postedAt
GET /transactions?cursor=<nextCursor>&limit=20&sort=-postedAt
```

```jsonc
{
  "items": [ /* Transaction[] */ ],
  "totalCount": 1284,
  "pageInfo": {
    "limit": 20,
    "offset": 0,
    "hasNextPage": true,
    "hasPreviousPage": false,
    "nextCursor": "eyJvIjoiLXBvc3RlZEF0LGlkIiwidiI6W…"
  }
}
```

- `pageInfo.nextCursor` is present only when more rows remain, and
  `hasNextPage` mirrors it. On the last page it is absent. Offset
  responses never carry it, so they are byte-identical to before.
- `totalCount` is the full filtered count, not the remainder.
- RPC `model.<Model>.list` takes the same key: `{"limit": 20, "cursor": ""}`.
  The server turns it into the equivalent query string and re-enters the REST
  path, so behaviour is identical on both transports.
- `limit` and `MAX_LIST_LIMIT` apply unchanged.

**Use a stable `sort`.** The effective order is your `sort` plus the primary
key ascending as a unique tiebreaker. With no `sort` the order is by `id`.
Ordering is `NULLS LAST` in both directions.

What the cursor is, and is not:

- **Opaque and unsigned.** It is a base64url token of at most 2048
  characters. Do not parse it or build one by hand on the client.
- **Bound to the effective sort.** Reusing a cursor after changing `sort` is
  a `400`.
- **Not bound to filters.** Changing `where` between pages gives pages of the
  new filter positioned by the old key.
- **Cannot expose hidden rows.** The cursor bound is `AND`ed with the
  request's filters and the model's read policy, so a forged cursor can only
  change where in the caller's own visible result the page starts.

Refused with `400` (RPC `invalid_argument`):

| Request | Why |
| --- | --- |
| `cursor` together with `offset` | the two modes are mutually exclusive |
| `cursor` on a model without `@@paged` | a bare-array response has nowhere to carry `nextCursor` |
| a relation-path `sort` (`author.name`) | no total order over a joined column |
| the same `sort` field twice | the order must be unambiguous |
| a `sort` on a Boolean, enum or JSON column | no total order |
| a malformed, oversized (over 2048 characters) or other-sort cursor | any bad cursor |

`cursor` is a **reserved query key** *(since 0.19.4)*: it is no longer
available as a plain filter name on a list route. Subscription feeds reject
`cursor`, and MCP does not expose it.

### Procedures: CursorPageInput and CursorPage&lt;T&gt;

Two more built-in types sit beside `PageInput` and `Page<T>`. `CursorPageInput`
is argument-only, `CursorPage<T>` is return-only:

```cstack
procedure listFeed(page: CursorPageInput): CursorPage<Post>
```

`CursorPageInput` is `{ limit: Int?, cursor: String? }`; `CursorPage<T>` is
`{ items: T[], nextCursor: String? }`, with `nextCursor` omitted on the last
page. `resolve(max_limit)` returns `(limit, Option<&str>)`, with `limit`
clamped to `[0, max_limit]` and an empty cursor read as `None`. The usual
implementation fetches `limit + 1` rows and lets `CursorPage::from_rows` drop
the extra one and mint the next cursor from the last kept row:

```rust
let (limit, cursor) = args.page.resolve(50);
// ... decode `cursor` with cratestack::decode_cursor(raw, &order, columns.len()),
//     AND the keyset bound into your query, and fetch `limit + 1` rows ...
Ok(cratestack::CursorPage::from_rows(rows, limit, |last| {
    cratestack::encode_cursor(&order, &[Some(last.title.clone()), Some(last.id.to_string())])
}))
```

`encode_cursor(order, values)` takes the canonical order string and the last
row's per-column wire values (`None` is SQL `NULL`); `decode_cursor` reads a
cursor back and returns a `BadRequest` for anything malformed, oversized or
minted for a different order. See `crates/cratestack-pg/tests/cursor_page_procedure.rs`
in the framework repository for a complete procedure.

### Embedded

There is no route on the embedded backend. The same primitives are
re-exported from `cratestack-sqlite`: `parse_keyset_sort` resolves a `sort`
into ordered columns (primary key appended), and `keyset_after` turns the last
row's values into an ordinary `FilterExpr` that you pass to
`find_many().where_expr(..)`:

```rust
let columns = parse_keyset_sort(Some("title"), "id", |name| {
    matches!(name, "title" | "id").then_some(false) // Some(is_nullable) or None
})?;
let order = keyset_order_spec(&columns);
let mut find = delegate.find_many()
    .order_by(title.asc()).order_by(id.asc()).limit(limit + 1);
if let Some(cursor) = cursor {
    let values = decode_cursor(cursor, &order, columns.len())?;
    find = find.where_expr(keyset_after(&columns, &values, leaf)?);
}
```

`leaf` is your closure mapping `(column, KeysetLeaf::{Eq, Gt, Lt, IsNull})` to
a typed field comparison. The full worked example is
`crates/cratestack-rusqlite/tests/cursor_pagination.rs`.

### Generated clients

| Client | List query | Response / procedure types |
| --- | --- | --- |
| Rust | the `("cursor", "")` query pair, e.g. `client.transactions().list(&[("cursor", ""), ("limit", "20")], &[])` | `PageInfo::next_cursor` |
| Dart | `CratestackListQuery(cursor: ...)` (and `toListQuery(cursor: ...)` on selections); for RPC list pass `{'cursor': ''}` in the input map | `PageInfo.nextCursor`, `CursorPageInput`, `CursorPage<T>` |
| TypeScript | `cursor?: string` on `CratestackFetchQuery` and `CratestackRpcListQuery` | `PageInfo.nextCursor?`, `CursorPageInput`, `CursorPage<T>` |

```ts
let cursor = "";
for (;;) {
  const page = await client.transactions.list({ query: { cursor, limit: 20, sort: ["-postedAt"] } });
  render(page.items);
  if (!page.pageInfo.nextCursor) break;
  cursor = page.pageInfo.nextCursor;
}
```

### Upgrading

`RpcListInput` has a new `cursor` field *(since 0.19.4)*, so an exhaustive
struct literal in your own code needs `cursor: None`.

## What this is not

1. **not cursor-based by default** — `limit`/`offset` on a table that is
   being written to concurrently can skip or repeat rows across page
   fetches. Send `?cursor=` to opt into
   [keyset paging](#cursor-pagination) *(since 0.19.4)*.
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
