---
title: Migrating to 0.8.0
description: Two breaking changes in 0.8.0 — the Cool* to Cratestack* type rename, and the decimal backend becoming additive with a new required macro argument.
---

# Migrating to 0.8.0

0.8.0 carries two breaking changes. Both are hard breaks — there is no deprecation window, no
`#[deprecated]` alias, and no way to opt back into 0.7.x behavior while staying on 0.8.0. Upgrading
means fixing both at once.

## 1. `Cool*` types renamed to `Cratestack*`

Every public `Cool*`-prefixed type is renamed to `Cratestack*` (cratestack#562 / #608), for a uniform
public-API prefix. **There is no `#[deprecated]` alias for any of these** — code referencing the old
names simply stops compiling on 0.8.0.

| Old name | New name |
|---|---|
| `CoolError` | `CratestackError` |
| `CoolContext` | `CratestackContext` |
| `CoolCodec` | `CratestackCodec` |
| `CoolErrorResponse` | `CratestackErrorResponse` |
| `CoolEventBus` | `CratestackEventBus` |
| `CoolEventEnvelope` | `CratestackEventEnvelope` |
| `CoolAuthIdentity` | `CratestackAuthIdentity` |
| `CoolEventFuture` | `CratestackEventFuture` |
| `CoolEnvelope` | `CratestackEnvelope` |
| `CoolPrincipal` | `CratestackPrincipal` |
| `CoolBody` | `CratestackBody` |

A small number of `cool_`-prefixed public **functions** (snake_case, same rename in spirit) are also
renamed as part of this same break:

| Old name | New name |
|---|---|
| `auth_error_to_cool_error` | `auth_error_to_cratestack_error` |
| `principal_to_cool_context` | `principal_to_cratestack_context` |
| `authenticate_cool_request` | `authenticate_cratestack_request` |
| `authenticate_cool_request_with` | `authenticate_cratestack_request_with` |
| `cool_error_code_to_rpc_code` | `cratestack_error_code_to_rpc_code` |
| `cool_error_from_sqlx` | `cratestack_error_from_sqlx` |
| `cool_error_to_status` | `cratestack_error_to_status` |
| `cool_error_code_to_tonic_code` | `cratestack_error_code_to_tonic_code` |
| `RpcErrorBody::from_cool_response` | `RpcErrorBody::from_cratestack_response` |
| `RpcErrorBody::from_cool` | `RpcErrorBody::from_cratestack` |
| `BatchItemError::from_cool` | `BatchItemError::from_cratestack` |

**Fix:** a mechanical find-and-replace across your own code — `Cool` → `Cratestack` on any identifier
matching the tables above. A plain global `Cool`→`Cratestack` text substitution is *not* safe if you
have unrelated identifiers containing "Cool" elsewhere in your codebase; scope the replacement to the
exact names above.

<Warning>
`CratestackContext` is not the same type as `RequestContext`. Both exist on `cratestack::AuthProvider`
today: `RequestContext` is the inbound request view your `authenticate(...)` implementation reads
(`method`/`path`/`headers`/`body`), and `CratestackContext` is the auth/principal result it produces.
Renaming `CoolContext` usages to `CratestackContext` is correct; don't conflate either with
`RequestContext`, which was never `Cool`-prefixed and is unaffected by this rename. See
[Auth Provider](../guides/auth-provider) for the full shape.
</Warning>

## 2. Decimal backends are now additive, and schemas with a `Decimal` field need a macro argument

Previously, `decimal-rust-decimal` and `decimal-bigdecimal` were mutually exclusive Cargo features —
enabling both was a hard `compile_error!`. As of 0.8.0 (cratestack#505 / #609) **both can be enabled
at once**, so two independent dependents in the same build graph can each choose their own backend
without forcing the other to match.

The part that requires a code change: because the macros can no longer infer a schema's backend from
the ambient (now possibly-both) Cargo feature set, **every `include_server_schema!`,
`include_embedded_schema!`, or `include_client_schema!` call on a schema that declares a `Decimal`
field anywhere — a model, mixin, custom type, view, or procedure arg/return, including nested inside
`Page<T>`/`FindMany<T>` — now requires a trailing `decimal = RustDecimal` or `decimal = BigDecimal`
argument.**

```rust
// Before (0.7.x)
include_server_schema!("schema.cstack", db = Postgres);

// After (0.8.0) — only if the schema has a Decimal field somewhere
include_server_schema!("schema.cstack", db = Postgres, decimal = RustDecimal);
```

The same trailing argument applies to `include_embedded_schema!("schema.cstack", decimal = RustDecimal)`
and `include_client_schema!("schema.cstack", decimal = BigDecimal)`.

**Fix:**

1. If your schema has no `Decimal` field anywhere, no change is needed — the macro call stays as-is.
2. If it does, add `decimal = RustDecimal` (matching the `decimal-rust-decimal` feature, the default) or
   `decimal = BigDecimal` (matching `decimal-bigdecimal`) to every `include_*_schema!` call site for
   that schema. The value must match a Cargo feature your crate actually has enabled — the argument
   selects which enabled backend the schema uses, it does not turn a feature on by itself.
3. Omitting the argument on a schema that needs one is a compile-time macro error naming exactly what
   to add, so a missed call site fails loudly rather than silently picking a backend.

See [Scalars: Decimal backend selection](../reference/scalars#backend-selection) for the full feature
reference.

## Order of operations

Both changes are independent — fix them in either order, or together. If you're also bumping the
`cratestack = { version = "0.7", ... }` pin in your `Cargo.toml` to `"0.8"`, do that as part of the
same change, since 0.7.x and 0.8.0 crates are not interchangeable on either point above.
