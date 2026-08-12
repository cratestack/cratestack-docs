---
title: Crypto Provider
description: Selecting the rustls crypto backend, and the current (non-functional) state of the `aws-lc-rs` option.
---

# Crypto Provider

Rustls supports multiple cryptographic backends. CrateStack exposes a
`crypto-aws-lc-rs` feature flag on `cratestack-pg`, but today that flag is
reserved and non-functional — see below before reaching for it.

## Default backend

This workspace currently ships against `ring`. (Rustls 0.23's own default
backend is actually `aws-lc-rs`; this workspace ends up on `ring` because a
downstream dependency, `reqwest`, overrides that default via its own
feature selection.) This is fine for:

1. development and CI
2. internal services that don't terminate TLS themselves
3. consumer-facing services in jurisdictions with no FIPS requirement

## FIPS-validated backend: not yet functional

`crypto-aws-lc-rs` (on `cratestack-pg`) is a **reserved, non-functional**
feature flag. Enabling it does not switch anything to a FIPS-validated
provider — it now triggers a hard `compile_error!` at build time (see
[cratestack#334](https://github.com/cratestack/cratestack/issues/334)):

```toml
[dependencies]
cratestack = { version = "...", features = ["crypto-aws-lc-rs"] }
```

```text
error: cratestack-pg's `crypto-aws-lc-rs` feature does not install a
FIPS-validated crypto provider yet — see install_fips_crypto_provider's
doc comment and https://github.com/cratestack/cratestack/issues/334.
Do not enable this feature.
```

This isn't a smaller bug that will be patched independently — `aws-lc-rs`
isn't even a dependency of `cratestack-pg` under any feature today, and
both `cratestack-sqlx` and `cratestack-client-rust` hard-select `ring` at
compile time regardless of this flag. Cargo features are purely additive,
so flipping `crypto-aws-lc-rs` on cannot subtract `ring` from the build —
there is no way, today, for this flag to actually change the TLS backend.
Making it real requires the TLS backend to become a genuine choice across
both of those crates first; that work is tracked in the issue above but
has not landed.

Previously, enabling the feature silently returned `Ok(())` from
`install_fips_crypto_provider()` without installing any provider — a
service that checked for `Ok` got an affirmative result while still
running on the non-FIPS `ring` backend. The `compile_error!` exists
specifically to make that false assurance impossible going forward: until
the backend-selection work lands, failing loudly at compile time beats
lying about what was installed.

`cratestack::install_fips_crypto_provider()` (available when a consumer
renames the `cratestack-pg` package to `cratestack`, as is conventional)
only exists on `cratestack-pg` — it is not part of `cratestack-api` or
`cratestack-sqlite`.

Without the feature flag (the unchanged, still-functional branch), the
function returns
`CoolError::Internal("cratestack was not compiled with \`crypto-aws-lc-rs\` feature; FIPS-validated crypto provider is unavailable")`.

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    cratestack::install_fips_crypto_provider()?;
    // ... build pool, router, etc.
    Ok(())
}
```

Calling this today — with or without the feature — never yields a working
FIPS-validated provider: without the feature it returns the `CoolError`
above, and with the feature it fails to compile.

## What this is not

1. **Not a working FIPS mode today.** Even once the backend-selection work
   above lands, selecting the feature would only let you compile a binary
   that uses the validated module — it wouldn't make the binary
   "FIPS-certified." That requires the vendor's validated binary and
   your organisation's accreditation process.
2. **Not a kernel-level toggle.** Even in a future working state, the
   feature would only affect rustls's crypto provider. Other TLS-using
   crates in the dependency graph (PostgreSQL drivers, HTTP clients) need
   their own selection.
3. **Not a database TLS configuration.** SQLx's PostgreSQL TLS is
   configured separately through the connection string and feature
   flags on `sqlx`.

## Read Next

1. [Banking readiness](../overview/banking-readiness) — the broader context for when FIPS matters in this stack
