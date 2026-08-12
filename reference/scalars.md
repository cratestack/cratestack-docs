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

## Decimal

The `Decimal` scalar exists specifically so banking code does **not** end
up using `Float` for money. Round-trip through `NUMERIC` is exact for
any value the chosen backend supports.

### Backend selection

The workspace has two backend feature flags, but only one of them
actually works today:

| Feature                  | Backend             | Type alias                     | Status |
|--------------------------|---------------------|---------------------------------|--------|
| `decimal-rust-decimal`   | `rust_decimal`      | `pub type Decimal = rust_decimal::Decimal;` | Default; works today. |
| `decimal-bigdecimal`     | `bigdecimal`        | `pub type Decimal = bigdecimal::BigDecimal;` | Reserved, **not implemented** — hard `compile_error!` if enabled. |

Default: `decimal-rust-decimal`.

`decimal-bigdecimal` exists only as a reserved feature name for future
work. Enabling it fails to compile with:

```text
cratestack: the decimal-bigdecimal backend is reserved but not yet
implemented; use decimal-rust-decimal for now
```

So today, `rust_decimal` is not a preference banks weigh against
`bigdecimal` — it's the only backend that compiles. Its properties: fixed
128-bit precision, faster arithmetic, and a smaller binary. 28–29
significant digits is enough for retail banking, FX rates, and
consumer-facing pricing. Arbitrary-precision support (for cumulative
compounding, very long-duration interest, or settlement workflows where
the precision budget grows over time) would land under
`decimal-bigdecimal` once it's implemented, but there is no working
alternative to `decimal-rust-decimal` right now.

Exactly one backend feature must be enabled. The umbrella `cratestack`
crate threads the feature through the workspace so downstream code
references `cratestack::Decimal` regardless of backend.

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
