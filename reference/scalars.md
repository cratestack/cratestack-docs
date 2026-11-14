---
title: Scalars
description: Built-in scalar types, including BigInt for exact 64-bit integers and the selectable Decimal backend for monetary fields.
---

# Scalars

The `.cstack` parser recognises a fixed set of scalar names. Each maps
to a Rust type, a SQL column type, and (where relevant) a serde
representation.

## Built-in scalars

| Scalar     | Rust type                        | Postgres type     | Notes                                                  |
|------------|----------------------------------|-------------------|--------------------------------------------------------|
| `String`   | `String`                         | `TEXT`            |                                                        |
| `Cuid`     | `String`                         | `TEXT`            | Validated as a CUID at the framework boundary.         |
| `Int`      | `i64`                            | `BIGINT`          | A JSON number. Still 64-bit — see [`BigInt`](#bigint). |
| `BigInt` *(since 0.15.4)* | `cratestack::BigInt` (wraps `i64`) | `BIGINT` | A decimal **string** on the wire. See [`BigInt`](#bigint). |
| `Float`    | `f64`                            | `DOUBLE PRECISION`| Avoid for money — use `Decimal`.                       |
| `Boolean`  | `bool`                           | `BOOLEAN`         |                                                        |
| `DateTime` | `chrono::DateTime<chrono::Utc>`  | `TIMESTAMPTZ`     |                                                        |
| `Decimal`  | `cratestack::Decimal`            | `NUMERIC`         | See backend selection below.                           |
| `Json`     | `cratestack::Json<cratestack::Value>` | `JSONB`      |                                                        |
| `Bytes`    | `Vec<u8>`                        | `BYTEA`           |                                                        |
| `Uuid`     | `cratestack::uuid::Uuid`         | `UUID`            | CBOR: 16-byte string; JSON: text. Servers accept either form on CBOR requests *(since 0.19.6, [cratestack#1359](https://github.com/cratestack/cratestack/issues/1359))*; generated TypeScript and Dart clients revive the bytes into a `string` / `String`. |

Type modifiers `?` (optional) and `[]` (list) apply on top of any scalar
where the underlying SQL type supports it.

## Extension scalars

Three further scalars exist only when the schema declares the matching
`extension` block **and** the consuming crate enables the same-named
Cargo feature. Declaring the block without the feature is a
`compile_error!`, not a silent no-op.

| Scalar | Extension | Rust type | Postgres type |
|---|---|---|---|
| `Vector(n)` | `extension pgvector { }` | `Vec<f32>` | `vector(n)` |
| `Geography(...)` | `extension postgis { }` | `Vec<u8>` (EWKB) | `geography(...)` |
| `Geometry(...)` | `extension postgis { }` | `Vec<u8>` (EWKB) | `geometry(...)` |

All three are Postgres-only: `include_embedded_schema!` rejects both
extensions outright, since the rusqlite backend has neither pgvector nor
SpatiaLite. None may be list-valued, and none is accepted in a procedure
signature.

See [Spatial Columns (PostGIS)](../guides/spatial-postgis) for the
geography/geometry argument forms, generated DDL and query builders.

## BigInt

*(since 0.15.4)*

`BigInt` is an exact 64-bit signed integer that never travels as a JSON
number. It exists because a JSON number above 2^53 is silently rounded to
an IEEE double by every JavaScript and dart2js consumer:
`JSON.parse('{"amountE8":9007199254740993}')` gives `9007199254740992`,
typed `number`, with no error. Use `BigInt` for any integer that can exceed
2^53 (nanosecond timestamps, amounts in minor units scaled by 10^8, 64-bit
ids from another system).

::: info
**`Int` has not changed.** The planned cutover that makes `Int` a 32-bit
integer (`i32`, `INTEGER`) has not landed. Today `Int` is still an `i64`,
still `BIGINT`, and still a JSON number, and a schema that declares no
`BigInt` generates what it generated before. A `BigInt` field is the way to
opt in to exact 64-bit transport now.
:::

### Types

| Where | Type |
|---|---|
| Rust | `cratestack::BigInt`, a `Copy` newtype over `i64` |
| Postgres | `BIGINT` (bound as `INT8`) |
| SQLite | an integer, same as `Int` |
| TypeScript client | `bigint`, with `BigIntFilter` |
| Dart client | `dart:core`'s `BigInt`, with `BigIntFilter` |

`cratestack::BigInt` offers `new` and `get`, `MIN` and `MAX`, `From<i64>`,
`From<BigInt> for i64`, `Display`, `FromStr`, `Ord`, `Hash`, `Default`, and
`checked_add`, `checked_sub` and `checked_mul` (each returning
`Option<BigInt>`). There are no operator impls and no `Deref`, so code that
still expects an `i64` is a compile error, not a silent precision loss. It
is 64-bit, not arbitrary precision (`num_bigint::BigInt` is a different
type).

### Where it is valid

Anywhere `Int` is:

- a `model`, `view`, `mixin` or `type` field, a procedure argument or
  return, and a `query` parameter
- `@id` and foreign keys (the driver impls for `INT8` and SQLite integers
  live in `cratestack-core`, so a `BigInt` key meets the generated
  delegates' bounds)
- `@version` (its `ETag` round-trips above 2^53), `@range` (bounds parse as
  `i64`; `@range ... @db_enforce` emits the `CHECK`), and a numeric
  `@default`, which must fit `i64`
- `@default(auth().x)`, where the claim may be a JSON integer or a canonical
  string; in a *policy comparison* a string claim against a number is
  undecidable and denies
- policy literals, and the comparable filters `eq`, `ne`, `lt`, `lte`, `gt`,
  `gte` and `in` on `<Model>Where`
- an [MCP](../guides/mcp) resource key, e.g.
  `cratestack://ledger/notes/9007199254740993`

It is not a subscription topic key (those are `String`, `Int` or `Uuid`).
A user `type`, `model` or `enum` named `BigInt` is a duplicate-name error.

### Wire encoding

A `BigInt` is a **canonical decimal string** on every codec: `0`, or an
optional `-`, a non-zero digit and at most 18 more digits, inside `i64`.

```json
{"id": "9007199254740993", "amountE8": "-250000000"}
```

- On JSON it is a JSON string. On CBOR it is a text string (major type 3),
  the same bytes, never an integer or a bignum tag.
- The server refuses a JSON number, a CBOR integer or bignum, `+5`, `007`,
  `-0`, `" 1"`, and anything outside `i64`, in a request body, a
  query-string filter and `?computedParams=`. A number is refused because a
  value above 2^53 may already have been rounded by the JavaScript that
  produced it. This is the rule [`Decimal`](#serialization) follows.
- JSON Schema (and MCP tool schemas) describe it as
  `{"type":"string","pattern":"^(0|-?[1-9][0-9]{0,18})$"}`, never `integer`.

### Clients

- **TypeScript.** Fields are `bigint`. Responses are revived strictly: a
  number, a non-canonical string or an out-of-range value at a `BigInt` key
  throws a `TypeError` naming the field (a number there means a server from
  before `BigInt`, whose value may already be rounded). Every `bigint` is
  stringified before it reaches a codec, because `JSON.stringify` throws on
  one. A custom `options.codec` is not wrapped; encode with
  `encodeWireFields` first.
- **Dart.** Fields are `BigInt`, exact on the VM, dart2js and dart2wasm. A
  malformed value throws a `FormatException` naming the field. RPC `get`,
  `update` and `delete` send a `BigInt` key as a string.

### Migrating from `Int`

Changing a field from `Int` to `BigInt` changes the wire form from number to
string, so deploy server and clients together. The column is already
`BIGINT`, but until the `Int` cutover lands `migrate diff` still emits a
no-op `ALTER COLUMN ... TYPE BIGINT` for the edit, classified `Lossy`, so it
needs `--allow-destructive`; it changes no data.

## Decimal

The `Decimal` scalar exists specifically so banking code does **not** end
up using `Float` for money. Round-trip through `NUMERIC` is exact for
any value the chosen backend supports.

### Backend selection

The workspace has two backend feature flags, and both are working,
tested backends today — the choice is a real tradeoff, not a
placeholder-vs-real one:

| Feature                  | Backend             | Type alias                     | Notes |
|--------------------------|---------------------|---------------------------------|--------|
| `decimal-rust-decimal`   | `rust_decimal`      | `pub type Decimal = rust_decimal::Decimal;` | Default. `Copy`, fixed 96-bit mantissa (~28–29 significant digits), faster arithmetic, smaller binary. |
| `decimal-bigdecimal`     | `bigdecimal`        | `pub type Decimal = bigdecimal::BigDecimal;` | Not `Copy` (heap-allocates its digit buffer via `num-bigint`, so call sites need an explicit `.clone()`). Arbitrary precision — round-trips values beyond `rust_decimal`'s capacity. |

Default: `decimal-rust-decimal`.

::: info
**Changed in 0.8.0 (cratestack#505).** The two Cargo features used to be
mutually exclusive — enabling both was a hard `compile_error!`. As of
0.8.0 they are **additive**: a build can enable both, and two independent
dependents in the same dependency graph can each pick a different backend
without forcing the other to match. This closed a real defect — two
well-formed crates, each choosing a different backend on its own terms,
used to force a combined build that neither one alone controlled. See
[Migrating to 0.8.0](../overview/migrating-to-0-8) for what changed and
what to update.
:::

Enabling **neither** feature is still not an error (cratestack#421/#505)
— it matters for a consumer that uses `default-features = false` to
narrow its dependency graph and never references `Decimal` at all: the
`Decimal` type alias simply doesn't exist in that build instead of
forcing an unused backend choice. A consumer that *does* try to use
`Decimal` without enabling either feature gets a plain "cannot find type
`Decimal`" from `rustc`.

`rust_decimal`'s 28–29 significant digits is enough for retail banking,
FX rates, and consumer-facing pricing, with better performance and a
smaller binary than the alternative. `bigdecimal`'s arbitrary precision
is for cases that can genuinely exceed that — cumulative compounding,
very long-duration interest, or settlement workflows where the
precision budget grows over time — at the cost of losing `Copy` and
heap-allocating every value.

The umbrella `cratestack` crate threads whichever feature(s) are selected
through the workspace so downstream code references `cratestack::Decimal`
for whichever single backend *that crate* enabled — `Decimal` itself
still names exactly one concrete type per crate, gated to whichever one
feature that crate turned on. What's new is that a different crate in the
same build graph can turn on the other feature and get its own concrete
`Decimal` without the two colliding.

### The `decimal = ...` macro argument

Because both backends can now coexist in one build, the entry macros can
no longer infer which one a given schema means from the ambient Cargo
feature set — a schema-authored choice replaces that inference. **Any
`include_server_schema!`, `include_embedded_schema!`, or
`include_client_schema!` call on a schema that declares a `Decimal` field
anywhere (a model, mixin, custom type, view, or procedure arg/return —
including nested inside `Page<T>`/`FindMany<T>`) now requires a trailing
`decimal = RustDecimal` or `decimal = BigDecimal` argument:**

```rust
include_server_schema!("schema.cstack", db = Postgres, decimal = RustDecimal);

include_embedded_schema!("schema.cstack", decimal = RustDecimal);

include_client_schema!("schema.cstack", decimal = BigDecimal);
```

Omitting `decimal = ...` on a schema that has a `Decimal` field somewhere
is a compile-time macro error naming exactly what to add — it does not
silently guess a backend. A schema with **no** `Decimal` field anywhere
still takes no `decimal` argument at all (cratestack#521's "neither"
case, unchanged). The value you pass must match a Cargo feature your
crate actually enabled (`decimal = RustDecimal` needs
`decimal-rust-decimal`, `decimal = BigDecimal` needs `decimal-bigdecimal`)
— the macro argument selects *which* enabled backend this schema's
`Decimal` fields use; it doesn't turn a backend on by itself.

### Serialization

`Decimal` serializes as a **JSON string**, not a number. This is
deliberate:

```json
{"amount": "1234.5600", "currency": "USD"}
```

A JSON number would round-trip through every consumer's `f64` parser and
lose precision. Banks that consume CrateStack responses from other
languages have one well-defined parse path: read the string, parse with
that language's exact-decimal library.

### Use with validators

`@range(min, max)` on a `Decimal` field promotes the integer bounds to
Decimal at runtime. `@range(min: 0, max: 1000000)` on
`amount Decimal` accepts `123.45`, rejects `-0.01`, and rejects
`1000000.01`.

See [validators](../guides/validators) for the broader validator surface.

## Choosing types for money

The recommended pattern:

```cstack
model Transfer {
  id Int @id
  amount Decimal @range(min: 0)
  currency String @iso4217
  reference String @length(min: 1, max: 64)
  version Int @version

  @@audit
}
```

Notes:

1. amounts are always `Decimal`, never `Float`
2. currency is always `String @iso4217`, not an enum — currency lists churn
3. `@version` is required for any row that two callers can race on
4. `@@audit` is required for any row a regulator can ask about
