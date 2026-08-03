---
title: Search with Filters — FindMany<Model>
description: FindMany<Model> — a typed, per-model search-with-filters procedure argument, generated from the same field accessors the REST list route already uses.
---

# Search with Filters — `FindMany<Model>`

A generated model's list route already takes `where`/`sort` query
parameters, but that's REST-only, untyped (a string grammar), and tied
to a plain CRUD list. `FindMany<Model>` gives a **procedure** the same
filtering and sorting capability as a real, typed argument — usable
over REST or RPC, and composable with a procedure's own business logic
before or after the query runs.

## Schema syntax

```cstack
model Post {
  id Int @id
  title String
  subtitle String?
  published Boolean
  authorId Int

  @@allow("read", auth() != null)
}

procedure searchPosts(query: FindMany<Post>): Post[]
  @allow(auth() != null)
```

Constraints enforced at parse/check time:

1. `FindMany<T>` is valid only in procedure-argument position — a model
   field, a `type` block field, or a procedure return type can't use it.
2. `T` must be a declared `model`, not a `type` block. Filtering needs a
   real table's columns; a `type` has none.

## What gets generated

For every model in the schema (unconditionally — same as
`Create<Model>Input`/`Update<Model>Input`, whether or not any procedure
actually declares a `FindMany<Model>` argument), the server composer
generates four things:

- **`<Model>Where`** — one optional filter per filterable scalar field.
  `PostWhere { id: Option<FieldFilterInput<i64>>, title: Option<FieldFilterInput<String>>, ... }`
- **`<Model>SortField`** — an enum with one variant per scalar field
  (every scalar field is sortable; unlike filtering, ordering has no
  type restriction).
- **`<Model>OrderByClause`** — `{ field: <Model>SortField, direction: SortDirection }`.
- **`<Model>FindManyInput`** — `{ where: Option<<Model>Where>, orderBy: Option<Vec<<Model>OrderByClause>> }`, what the `FindMany<Model>` argument actually decodes into, plus a
  `build_<model>_query_from_find_many(db, input)` function that turns a
  decoded input into a ready-to-run query builder.

None of this duplicates the REST list route's filter grammar or
field-name validation — `<Model>Where::to_filters()` calls straight
into the same `FieldRef` field accessors (`super::post::title()`,
`super::post::published()`, …) the REST `?where=` route and every other
typed query already use. A field that's invalid to filter on is a
compile error (it's a struct field, not a string a caller could
mistype), not a runtime `400`.

In your procedure implementation:

```rust
impl cratestack_schema::procedures::ProcedureRegistry for Procedures {
    async fn search_posts(
        &self,
        db: &cratestack_schema::Cratestack,
        ctx: &CoolContext,
        args: cratestack_schema::procedures::search_posts::Args,
    ) -> Result<Vec<cratestack_schema::Post>, CoolError> {
        cratestack_schema::build_post_query_from_find_many(db, &args.query)
            .run(ctx)
            .await
    }
}
```

## Filter operators

Every `<Model>Where` field is one of six shared filter shapes, matching
whichever operators actually make sense for that scalar type:

| Filter | Fields | Applies to |
|---|---|---|
| `StringFilter` | `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`, `contains`, `startsWith`, `isNull` | `String`, `Cuid` |
| `NumberFilter` | `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`, `isNull` | `Int`, `Float` |
| `BooleanFilter` | `eq`, `ne`, `in`, `isNull` | `Boolean` |
| `UuidFilter` | `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`, `isNull` | `Uuid` |
| `DateTimeFilter` | `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`, `isNull` | `DateTime` |
| `DecimalFilter` | `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`, `isNull` | `Decimal` |

Notes:

- `contains`/`startsWith` exist only on `StringFilter` — the only two
  types `FieldRef`'s own `.contains()`/`.starts_with()` are implemented
  for.
- `isNull` only makes sense (and is only offered by the generated
  client types) for a field declared `?` in the schema — a required
  field is never null, so there's nothing to test.
- `Json`, `Bytes`, enum, and custom `type` fields aren't filterable at
  all — `<Model>Where` simply has no field for them, matching the
  untyped REST `?where=` route's own coverage.
- Relation fields aren't filterable either — `PostWhere` only ever
  covers `Post`'s own scalar columns, not `author.name`.

## Wire format

Structured JSON, not a string grammar — a `FindMany<Post>` argument
serializes as:

```jsonc
{
  "query": {
    "where": {
      "published": { "eq": true },
      "title": { "contains": "release" }
    },
    "orderBy": [
      { "field": "publishedAt", "direction": "desc" },
      { "field": "title", "direction": "asc" }
    ]
  }
}
```

Every operator a filter doesn't set is simply absent (or `null`) — the
caller only sends what it's actually filtering on. Multiple operators
on the same field combine with AND (`{ "gte": 10, "lt": 100 }` means
"between 10 and 100"); multiple filtered fields also combine with AND.

**`orderBy` is a list of `{ field, direction }` clauses, not a
field-keyed object.** A JSON object's key order isn't guaranteed to
survive every parser — `serde_json::Map` alphabetizes keys by default,
and other languages' map/dict implementations make no ordering promise
either. A list is the only shape that reliably preserves "sort by
`published` first, then `title`" instead of silently becoming "sort by
`title` first."

This is identical over REST and RPC: on `transport rpc`, `query` is
just another key in the unary call's `input` object
(`{"op": "procedure.searchPosts", "input": {"query": {...}}}`) — see
[RPC transport](./rpc-transport) for the general request/response
envelope this composes with.

## Composing with pagination

`FindMany<Model>` and [`PageInput`](./pagination#procedure-arguments-pageinput)
are separate, orthogonal arguments — filtering/sorting is one concern,
pagination is another:

```cstack
procedure searchPosts(query: FindMany<Post>, page: PageInput): Page<Post>
```

There's no single convenience method that combines them — `FindMany<'a,
M, PK>`'s `.limit()`/`.offset()` slice the result set, but computing
`totalCount` for the `Page<T>` envelope is a second, separate query,
same as a generated `@@paged` list route's own handler does it. Reuse
`<Model>Where::to_filters()` against both the list query and a
`.aggregate().count()` query so the same predicate applies to both:

```rust
impl cratestack_schema::procedures::ProcedureRegistry for Procedures {
    async fn search_posts(
        &self,
        db: &cratestack_schema::Cratestack,
        ctx: &CoolContext,
        args: cratestack_schema::procedures::search_posts::Args,
    ) -> Result<cratestack::Page<cratestack_schema::Post>, CoolError> {
        let (limit, offset) = args.page.resolve(50);
        let filters = args
            .query
            .r#where
            .as_ref()
            .map(|where_| where_.to_filters())
            .unwrap_or_default();

        let items = cratestack_schema::build_post_query_from_find_many(db, &args.query)
            .limit(limit)
            .offset(offset)
            .run(ctx)
            .await?;

        let total_count = db
            .post()
            .aggregate()
            .count()
            .where_any(filters)
            .run(ctx)
            .await?;

        Ok(cratestack::Page::new(
            items,
            cratestack::PageInfo {
                limit: Some(limit),
                offset: Some(offset),
                has_next_page: offset + limit < total_count,
                has_previous_page: offset > 0,
            },
        )
        .with_total_count(Some(total_count)))
    }
}
```

See [Pagination](./pagination) for the full `Page<T>`/`PageInfo`
contract this mirrors.

## Generated clients

Rust (the same generated types the server uses — `include_client_schema!`
generates the identical `<Model>Where`/`<Model>SortField`/
`<Model>OrderByClause`/`<Model>FindManyInput` structs, just without the
DB-backed `build_<model>_query_from_find_many` function, which needs a
live `Cratestack` handle a pure HTTP client doesn't have):

```rust
let results = client
    .procedures()
    .search_posts(
        &cratestack_schema::procedures::search_posts::Args {
            query: cratestack_schema::PostFindManyInput {
                r#where: Some(cratestack_schema::PostWhere {
                    published: Some(cratestack::FieldFilterInput {
                        eq: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                order_by: Some(vec![cratestack_schema::PostOrderByClause {
                    field: cratestack_schema::PostSortField::Title,
                    direction: cratestack::SortDirection::Asc,
                }]),
            },
        },
        &[],
    )
    .await?;
```

TypeScript — per-model `PostWhere`/`PostFindMany` interfaces, backed by
shared `StringFilter`/`NumberFilter`/`BooleanFilter`/`UuidFilter`/
`DateTimeFilter`/`DecimalFilter` interfaces (themselves built on shared
`EqualityFilter<V>`/`ComparableFilter<V>` base shapes) — hardcoded once
per package, the same way `Page`/`PageInfo`/`PageInput` are:

```ts
const results = await client.procedures.searchPosts({
  query: {
    where: { published: { eq: true } },
    orderBy: [{ field: "title", direction: "asc" }],
  },
});
```

Dart (default and `riverpod` presets both emit the same per-model
`PostWhere`/`PostSortField`/`PostOrderByClause`/`PostFindMany` classes;
under `riverpod`, every one of them — plus the shared filter classes —
is `@MappableClass()`-annotated, so a `PostFindMany` passed as a
`@riverpod` family-provider argument gets real structural equality
instead of comparing by identity):

```dart
final results = await client.procedures.searchPosts(
  const SearchPostsArgs(
    query: PostFindMany(
      where: PostWhere(published: BooleanFilter(eq: true)),
      orderBy: [PostOrderByClause(field: PostSortField.title, direction: SortDirection.asc)],
    ),
  ),
);
```

## What this is not

1. **not relation-aware** — `PostWhere` only covers `Post`'s own scalar
   fields. Filtering by a related model's field (`author.name`) isn't
   supported; build that inside your procedure's own logic instead.
2. **not `.select`/`.include`** — `FindMany<Model>` covers `where`/
   `orderBy` only. Typed field-selection/relation-inclusion builders for
   procedure arguments are a documented future direction, not
   implemented today.
3. **not a replacement for the REST list route's `?where=`/`?sort=`** —
   that untyped string grammar still exists, unchanged, for plain CRUD
   list routes. `FindMany<Model>` is specifically for procedures that
   want the same capability as a typed argument.
4. **not free of the same validation the list route already runs** — a
   filter that references a field outside `allowed_fields()` (a
   `@server_only` field, for instance) simply isn't representable:
   `<Model>Where` has no field for it, so there's nothing to reject at
   runtime.

## Read Next

1. [Pagination](./pagination) — `PageInput`/`Page<T>`, the argument/return-type pair `FindMany<Model>` composes with
2. [RPC Transport](./rpc-transport) — the request/response envelope `FindMany<Model>` arguments travel in over RPC
3. [TypeScript Client Generation](./typescript-client-generation) and [Dart Client Generation](./dart-client-generation) — full per-language client codegen coverage
