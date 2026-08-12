---
title: Validators
description: Runtime validation attributes for Create/Update inputs — `@length`, `@range`, `@email`, `@regex`, `@uri`, `@iso4217`.
---

# Validators

Validators reject malformed input at the framework boundary — before the
mutation reaches the database, before the audit row is written, before any
policy fires. The macro-generated `validate(&self)` implementation runs on
every Create or Update input.

## Available attributes

| Attribute   | Applies to         | Behaviour                                                  |
|-------------|--------------------|------------------------------------------------------------|
| `@length`   | `String`, `Bytes`  | Rejects shorter than `min` or longer than `max`            |
| `@range`    | `Int`, `Decimal`   | Rejects below `min` or above `max` (inclusive)             |
| `@email`    | `String`           | Pragmatic shape check — single `@`, non-empty local/domain |
| `@regex`    | `String`           | Pattern compiled once, matched on every input              |
| `@uri`      | `String`           | Rejects values that fail `url::Url::parse`                 |
| `@iso4217`  | `String`           | Accepts only 3 ASCII uppercase letters                     |

Each attribute is composable. A field can declare multiple validators and
the macro emits them in source order.

## Examples

```cstack
model Member {
  id Int @id
  email String @email @length(min: 3, max: 254)
  currency String @iso4217
  slug String @regex("^[a-z0-9-]+$")
  amount Decimal @range(min: 0, max: 1000000)
}
```

## Error shape

Validation failures surface as `CoolError::Validation(message)`, code
`VALIDATION_ERROR`, HTTP status `422 Unprocessable Entity`.

The public message **never echoes the rejected value**. A bank rejecting
`super-secret@bank` for malformed email returns:

```http
HTTP/1.1 422 Unprocessable Entity

field 'email' is not a valid email address
```

This is a deliberate choice: validation errors land in 4xx logs the same
way 4xx responses do, and banks treat 4xx logs as searchable indefinitely.
Echoing the user-supplied value into the message would leak PII into log
storage that doesn't enforce the same retention rules as the database.

## `@range` on Decimal

`@range(min, max)` accepts integer bounds (the parser only takes i64
literals). On a Decimal field the bounds are promoted to `Decimal` at
runtime and compared exactly — `@range(min: 0)` on `amount Decimal`
rejects `-0.01`, not just `-1`.

Fractional bounds (`@range(min: 0.01)`) require a separate parser change
and are tracked outside the banking-readiness track.

## `@regex`

Patterns are validated at macro expansion time — a malformed regex fails
the build, not the request. The compiled `Regex` lives in a
`std::sync::LazyLock` so each unique pattern compiles once per process.

## `@email`

Validates only the shape:

1. exactly one `@`
2. non-empty local part
3. non-empty domain part
4. at least one `.` in the domain
5. no whitespace anywhere

This is intentionally minimal. Banks running KYC validate at a deeper
layer; the framework only rejects values that are obviously not addresses.
RFC 5322 quoted local parts and IP literals are rejected — those forms
banks rarely accept anyway.

## `@iso4217`

Three ASCII uppercase letters. The framework does **not** check the value
against the registered ISO 4217 list — that table churns. Banks pin
allowed currencies via a separate allow-list or a policy check.

## Database-level enforcement (`@db_enforce`)

Validators are app-level by default — they run in the framework-generated `validate(&self)` and the database has no record of them. That is the right default for `@email`, `@uri`, and complex `@regex` patterns: those rely on host-language parsers, and expressing them in SQL means a regex approximation that drifts from the Rust behavior.

For validators whose semantics translate cleanly to SQL, opt into database-level CHECK constraints with `@db_enforce`. It's a field-level attribute — it goes inline on the field, next to the other field attributes like `@range`/`@iso4217`, not on its own line at the model level:

```cstack
model Member {
  amount   Decimal @range(min: 0, max: 1000000) @db_enforce
  currency String  @iso4217                     @db_enforce
  email    String  @email                       // app-only — @email is not eligible
}
```

Eligible validators: `@range`, `@length`, `@iso4217`. Non-eligible: `@email`, `@uri`, `@regex`. Applying `@db_enforce` to a non-eligible validator is currently silently skipped by the migration converter, not a parse-time error (a stricter parser-level check that promotes this to a build-time error may come later).

When set, the migration generator ([ADR 0004](../internals/schema-diff-adr#validator-promotion-db_enforce)) emits a `CHECK` constraint with a predictable name (`<table>_<field>_<validator>_check`) alongside the column. Subsequent validator changes flow through the diff engine:

* **Loosening** the rule (widening a range, dropping the attribute) — safe.
* **Tightening** the rule (narrowing a range) — lossy if existing rows fall outside the new bound; requires `--allow-destructive` or a hand-written `up.pre.sql` that resolves violators first.
* **Adding `@db_enforce`** to a field that previously lacked it — treated as a tightening, for the same reason: data written before the constraint existed may not satisfy it.

Defense-in-depth — app validators still run before the request reaches the database. `@db_enforce` is the safety net for non-framework writers (direct SQL, replication tools, sibling services). For banking workloads where the storage tier must enforce invariants independently, prefer `@db_enforce` on every eligible validator.

**Error path:** a CHECK violation surfaces as a constraint error from the database driver and is mapped to `CoolError::Internal` by default, not the 422 contract documented above. Validators run app-side first specifically so the 422 path remains the user-facing surface; `@db_enforce` violations are the "should be unreachable" backstop.

## Composition with policies

Validation runs **before** policy evaluation. A request that fails
`@email` is rejected with 422 without ever reaching `@@allow("create",
...)`. This keeps policy code free of input-shape concerns.

## When to add them

Add validators when:

1. the field has a wire format constraint that can be checked in isolation (email, currency code, slug regex)
2. the field carries a domain bound (non-negative amounts, capped quantities)
3. the value reaches downstream systems that have stricter parsing than the database type

Skip validators when:

1. the check needs database state (uniqueness, foreign key reachability) — that's a policy concern
2. the rule depends on the caller's role — that's a policy concern
3. the column is generated server-side (`@version`, `@default(auth().id)`)

## Read Next

1. [Field attributes](../reference/field-attributes) — the broader attribute surface
2. [Auth provider](./auth-provider) — policies run after validators
3. [ADR 0004: Schema diff and migration generation](../internals/schema-diff-adr#validator-promotion-db_enforce) — how `@db_enforce` flows through migration generation
