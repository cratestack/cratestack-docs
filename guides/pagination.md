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

- both are optional `Int`s; a non-numeric value is a `400` with a
  message naming the bad parameter
- **`limit` is not defaulted and not capped.** Omitting it returns
  every row from `offset` onward, in one response, and — per the
  `hasNextPage` semantics below — that response reports itself as the
  final page. If you need an enforced page-size ceiling, apply it in
  your own policy or gateway layer; the framework doesn't impose one.
- `offset` defaults to `0` when omitted

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
  filter, ignoring `limit`/`offset`. Computed with a second query (a
  `COUNT` over the same filtered predicate) run alongside the list
  query — a paged list costs two round trips to the database, not one.
- `pageInfo.limit` / `pageInfo.offset` — echo exactly what the request
  supplied (`null` if the caller omitted `limit`)
- `pageInfo.hasNextPage` — `false` whenever `limit` was omitted (an
  unbounded fetch is definitionally the last page); otherwise
  `offset + limit < totalCount`
- `pageInfo.hasPreviousPage` — `offset > 0`

A non-`@@paged` model's list route is unaffected — it keeps returning a
bare array, and `limit`/`offset` have no special handling for it.

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

## What this is not

1. **not cursor-based** — no opaque cursor token, no keyset pagination.
   `offset` on a table that's being written to concurrently can skip or
   repeat rows across page fetches, same as any offset-based scheme.
2. **not a size limit enforcement mechanism** — see the query-contract
   note above; nothing in the framework stops a caller from requesting
   every row in one shot.
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
