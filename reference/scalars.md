---
title: Scalars
description: Built-in scalar types, including the selectable Decimal backend for monetary fields.
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
| `Int`      | `i64`                            | `BIGINT`          |                                                        |
| `Float`    | `f64`                            | `DOUBLE PRECISION`| Avoid for money — use `Decimal`.                       |
| `Boolean`  | `bool`                           | `BOOLEAN`         |                                                        |
| `DateTime` | `chrono::DateTime<chrono::Utc>`  | `TIMESTAMPTZ`     |                                                        |
| `Decimal`  | `cratestack::Decimal`            | `NUMERIC`         | See backend selection below.                           |
| `Json`     | `cratestack::Json<cratestack::Value>` | `JSONB`      |                                                        |
| `Bytes`    | `Vec<u8>`                        | `BYTEA`           |                                                        |
| `Uuid`     | `cratestack::uuid::Uuid`         | `UUID`            |                                                        |

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

<Info>
**Changed in 0.8.0 (cratestack#505).** The two Cargo features used to be
mutually exclusive — enabling both was a hard `compile_error!`. As of
0.8.0 they are **additive**: a build can enable both, and two independent
dependents in the same dependency graph can each pick a different backend
without forcing the other to match. This closed a real defect — two
well-formed crates, each choosing a different backend on its own terms,
used to force a combined build that neither one alone controlled. See
[Migrating to 0.8.0](../overview/migrating-to-0-8) for what changed and
what to update.
</Info>

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
