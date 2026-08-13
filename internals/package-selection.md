# CrateStack Package Selection and Dependency Decision Log

> **Staleness notice:** this document's crate/package inventory was last substantially updated around v0.3.0 (2026-05-12) and is now significantly behind current source (v0.7.15) — roughly 3 months and ~40 point-releases. Entire crates and packages shipped since then (the `cratestack-pg` / `cratestack-api` / `cratestack-sqlite` facade split, `cratestack-grpc` / `cratestack-proto`, `cratestack-sql`, the client codegen and Studio crates, and most of the `packages/*` TypeScript split) are not reflected below. For the current, authoritative package list, run `ls crates/` and `ls packages/` in the source repo, or consult a live reference doc rather than this historical log.

## Status

Accepted for the initial workspace bootstrap. **Updated 0.3.0** — `cratestack-sqlx` now depends on `sqlx-core` + `sqlx-postgres` directly instead of the umbrella `sqlx` crate (the umbrella's `sqlx-sqlite` optional dep was leaking into the resolve graph and conflicting with `rusqlite 0.39`'s `libsqlite3-sys 0.37`). `cratestack-lsp` migrated from the unmaintained `tower-lsp 0.20` to the active community fork `tower-lsp-server 0.23`. `cratestack-sqlite-wasm` was deleted — `rusqlite 0.39` transparently targets `wasm32-unknown-unknown` via `sqlite-wasm-rs`, so `cratestack-rusqlite` now serves all three deployment targets (mobile native, desktop, browser via OPFS) from one source.

**Updated 0.4.0+** — the public `cratestack` crate split into disjoint facades, selected via Cargo's `package =` rename: `cratestack = { package = "cratestack-pg" }` (Postgres + Axum + Rust client runtime), `cratestack = { package = "cratestack-sqlite" }` (rusqlite, native + wasm), and a third, `cratestack = { package = "cratestack-api" }`, added later for `db = None` procedures-only servers — `sqlx`/`cratestack-sqlx` are structurally absent from its dependency graph, not just feature-gated off. `cratestack-pg` itself later gained a default-on `postgres` Cargo feature gating its own `cratestack-sqlx` dependency, so a `db = None` consumer of `cratestack-pg` can shed sqlx with `default-features = false` instead of switching facades outright. `cratestack-pg` also gained an optional `grpc` feature (`dep:cratestack-grpc`, `dep:prost` — required as a direct dependency, not just a re-exported module path, because `prost-derive`'s `#[derive(Message)]` expansion hardcodes bare `::prost::...` paths with no crate-rename escape hatch) for `transport grpc` schemas, and a `crypto-aws-lc-rs` feature that is currently a reserved name only — enabling it is a hard `compile_error!`, not a working FIPS mode, since making it real needs the TLS backend to become a genuine choice across `cratestack-sqlx`/`cratestack-client-rust` first (both currently hard-select the `ring` rustls backend).

## Date

2026-04-26 (initial). 0.3.0 update: 2026-05-12. 0.4.0+ update: 2026-08-03.

## Scope

This document records the current package and dependency decisions for CrateStack v0.

It covers:

* runtime dependencies
* procedural macro dependencies
* parser and diagnostics dependencies
* database dependencies
* HTTP framework dependencies
* codec dependencies
* COSE dependencies
* generated-client dependencies
* testing dependencies
* dependencies explicitly deferred or rejected

This is not a lockfile. Exact patch versions should be controlled by `Cargo.lock` and release policy. This document records architectural dependency choices and the rationale behind them.

---

## 1. Dependency Philosophy

CrateStack should be dependency-conscious but not dependency-minimal at the cost of correctness or developer experience.

Dependency choices should optimize for:

1. correctness
2. long-term maintainability
3. Rust ecosystem maturity
4. compile-time ergonomics
5. security posture
6. clear ownership boundaries
7. compatibility with Axum, Tokio, SQLx, Serde, CBOR, and COSE
8. avoiding JSON as a core assumption
9. keeping optional features optional

CrateStack should avoid pulling heavy dependencies into core when they are only needed for a specific integration.

Core should stay transport- and framework-light where possible.

---

## 2. Feature and Crate Boundary Policy

Dependencies should live in the narrowest crate that needs them.

Original recommended workspace (0.1.0 bootstrap — kept for history; see the real current layout below):

```text
cratestack/
  crates/
    cratestack/
    cratestack-core/
    cratestack-parser/
    cratestack-policy/
    cratestack-macros/
    cratestack-sqlx/
    cratestack-axum/
    cratestack-codec-cbor/
    cratestack-codec-json/
    cratestack-cose/
    cratestack-client-rust/
    cratestack-client-dart/
    cratestack-cli/
    cratestack-lsp/
  packages/
    cratestack-vscode/
```

> **This tree is stale** (see the staleness notice at the top of this document). It reflects roughly the v0.3.0 workspace and omits crates and packages added since, including at least:
>
> * `cratestack-pg` — the real successor to the old umbrella `cratestack` crate: Postgres/sqlx backend + Axum HTTP bindings + generated Rust client runtime; consumed via `cratestack = { package = "cratestack-pg" }`. The bare `cratestack` crate above is now an empty, documentation-only landing page with zero dependencies.
> * `cratestack-api` — sibling facade for procedures-only, no-database services (`db = None`); structurally never depends on `cratestack-sqlx`.
> * `cratestack-sqlite` — third facade, embedded SQLite runtime (native + wasm32), consumed via `cratestack = { package = "cratestack-sqlite" }`.
> * `cratestack-grpc` — gRPC server runtime (tonic/prost) for `transport grpc` schemas.
> * `cratestack-sql` — shared SQL value/type abstraction layer used by both sqlx and rusqlite backends.
> * `cratestack-proto` — owns the `.proto` field-number lockfile/stable-numbering algorithm for `transport grpc` schemas.
> * `cratestack-studio` / `cratestack-studio-generator` / `cratestack-studio-ui` — admin/testing web app for `.cstack` schemas (`cratestack studio run`), a Leptos+Trunk WASM UI embeddable into the server binary.
> * A 9-package TypeScript npm split under `packages/` — `ts-types`, `link-batch`, `link-logger`, `runtime-fetch`, `runtime-axios`, `validator-zod`, `validator-yup`, `adapter-tanstack-query`, `adapter-rtk` — replacing the single `cratestack-vscode` entry shown above (which itself still exists as an editor package).
>
> Run `ls crates/` and `ls packages/` in the source repo for the full, current list.

Dependency boundary rules:

1. `cratestack-core` must not depend on Axum.
2. `cratestack-core` must not depend on SQLx unless unavoidable.
3. `cratestack-core` must not depend on JSON-specific crates.
4. `cratestack-core` may depend on Serde traits.
5. `cratestack-sqlx` owns SQLx.
6. `cratestack-axum` owns Axum, Tower, HTTP-body integration.
7. `cratestack-codec-cbor` owns the Serde-based CBOR codec surface built on `minicbor-serde`.
8. JSON support currently lives inline in `cratestack-client-rust` rather than a dedicated `cratestack-codec-json` crate.
9. COSE is currently a reserved runtime seam rather than a dedicated implemented `cratestack-cose` crate.
10. `application/cbor-seq` is a planned framing-aware transport mode and is not implemented today.
11. `cratestack-macros` owns proc-macro dependencies.
12. `cratestack-client-rust` owns generated Rust client runtime support.
13. `cratestack-client-dart` owns generated Dart or Flutter package generation.
14. `cratestack-cli` owns CLI and terminal diagnostics dependencies.
15. `cratestack-lsp` owns LSP/editor protocol behavior over parser and semantic surfaces.
16. `cratestack-vscode` is a thin editor wrapper that contributes the `.cstack` language and launches `cratestack-lsp`.

## 2.1 Current Direction Update

Bootstrap implementation started with generated server-side CRUD and procedure routes. The current target direction is broader:

1. generated HTTP routes are canonical APIs
2. Rust client generation is a first-class output
3. Dart client generation forked into two paths that both render through repo-managed MiniJinja templates (callers can override with a template directory): the `cratestack-client-flutter` FFI bridge crate (Dart → bridge JSON bytes → Rust → HTTP, transport codec ownership stays in Rust) is one path, but the actual default/`riverpod`-preset generated Dart talks to the server **directly via `dio`**, no FFI bridge in the loop — see [Client Runtime Architecture](../architecture/client-runtime) for the two paths in full. Both emit multiple sibling files per client package and expose canonical `fields` / `include` / `includeFields[path]` query params plus generated field/include constants, generated selection builders, and projected wrapper objects, even though exact selection-aware typed responses are still incomplete; the Rust side also exposes nested selection builders, a generated schema-native client facade, additive selected `get/list` helpers, and request-authorizer hooks over the canonical HTTP contract
4. JSON and CBOR are first-class codecs, while COSE remains an envelope layer
5. transport architecture is split into codec, framing, and envelope; sequence transports such as `application/cbor-seq` belong to framing
6. CRUD exposure, field visibility, and field filterability are schema-controlled concerns
7. custom fields resolve through generated resolver traits
8. authentication remains delegated to host integrations

---

## 3. Dependency Categories

Each dependency decision uses one of these statuses:

```text
ADOPT       use in v0
ADOPT OPTIONAL use behind feature flag or integration crate
DEFER       do not use in v0, reconsider later
REJECT      do not use unless a future ADR reverses this decision
WATCH       promising, but do not commit yet
```

---

# 4. Core Runtime Dependencies

## 4.1 `serde`

Status: ADOPT

Purpose:

* derive serialization/deserialization for generated models
* enable codec-agnostic request/response handling
* support CBOR, JSON, and future codecs

Used by:

* `cratestack-core`
* generated schema code
* codec crates
* REST integration crates

Recommended features:

```toml
serde = { version = "1", features = ["derive"] }
```

Rationale:

Serde is the standard Rust serialization framework and is necessary for codec-agnostic generated types.

Decision:

Serde is foundational and should be part of the public generated type contract.

---

## 4.2 `thiserror`

Status: ADOPT

Purpose:

* define typed library errors
* derive `std::error::Error`
* keep error types structured and stable

Used by:

* `cratestack-core`
* parser
* policy engine
* SQLx integration
* codec crates
* COSE crate

Recommended dependency:

```toml
thiserror = "2"
```

Rationale:

CrateStack is a library. `thiserror` is better than `anyhow` for public error types because it preserves structured error variants.

Decision:

Use `thiserror` for public and internal library errors.

---

## 4.3 `anyhow`

Status: ADOPT OPTIONAL

Purpose:

* application examples
* CLI command plumbing
* integration tests

Used by:

* `cratestack-cli`
* examples
* tests

Recommended dependency:

```toml
anyhow = "1"
```

Rationale:

`anyhow` is convenient for binaries and examples, but should not be used as the main public error surface of CrateStack library crates.

Decision:

Use in CLI/examples/tests only. Do not expose as the primary library error type.

---

## 4.4 `bytes`

Status: ADOPT

Purpose:

* efficient HTTP body byte handling
* request/response body integration
* codec/envelope pipeline

Used by:

* `cratestack-core`
* `cratestack-axum`
* codec crates
* envelope crates

Recommended dependency:

```toml
bytes = "1"
```

Rationale:

The codec and envelope pipeline operates on byte buffers. `bytes` is standard across the Tokio/Hyper/Axum ecosystem.

Decision:

Adopt for byte-oriented transport internals.

---

## 4.5 `http`

Status: ADOPT

Purpose:

* HTTP status codes
* headers
* content type handling
* framework-neutral HTTP types where possible

Used by:

* `cratestack-core`, if framework-neutral HTTP concepts are needed
* `cratestack-axum`

Recommended dependency:

```toml
http = "1"
```

Rationale:

Using the `http` crate avoids coupling basic status/header concepts directly to Axum.

Decision:

Adopt where framework-neutral HTTP types are useful.

---

## 4.6 `tracing`

Status: ADOPT OPTIONAL

Purpose:

* structured logs
* request tracing
* generated query/procedure diagnostics
* policy decision traces in debug mode

Used by:

* `cratestack-sqlx`
* `cratestack-axum`
* optionally core internals

Recommended dependency:

```toml
tracing = "0.1"
```

Rationale:

`tracing` is the standard async Rust instrumentation ecosystem.

Decision:

Use internally where helpful, but avoid forcing a logging setup on applications.

---

# 5. Async Runtime Dependencies

## 5.1 `tokio`

Status: ADOPT

Purpose:

* async runtime compatibility
* required by Axum/SQLx setup
* examples and integration tests

Used by:

* `cratestack-axum`
* `cratestack-sqlx`
* examples
* integration tests

Recommended dependency:

```toml
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

For examples:

```toml
tokio = { version = "1", features = ["full"] }
```

Rationale:

CrateStack v0 is Axum-first and SQLx-backed; Tokio is the natural runtime.

Decision:

Adopt Tokio as the supported async runtime for v0.

---

## 5.2 `async-trait`

Status: ADOPT

Purpose:

* generated async procedure traits
* integration traits where async trait methods are needed

Used by:

* generated schema code
* `cratestack-core` or `cratestack-axum`

Recommended dependency:

```toml
async-trait = "0.1"
```

Rationale:

Rust async functions in traits are increasingly usable, but object-safe async trait patterns remain simpler with `async-trait`, especially for generated procedure handler traits stored behind trait objects.

Decision:

Use `async-trait` in v0 for procedure implementations and handler registration ergonomics.

Review later when native async trait ergonomics and object-safety patterns are sufficient.

---

# 6. Database Dependencies

## 6.1 `sqlx`

Status: ADOPT

Purpose:

* async PostgreSQL access
* connection pooling
* query execution
* row decoding
* transactions

Used by:

* `cratestack-sqlx`
* generated schema code where needed

Recommended dependency:

```toml
sqlx = { version = "0.8", default-features = false, features = [
  "runtime-tokio",
  "postgres",
  "macros",
  "uuid",
  "chrono",
  "time",
  "json"
] }
```

Notes:

* `macros` is useful for tests, examples, and static queries, but generated dynamic queries should primarily use `QueryBuilder`.
* `json` here refers to database JSON/JSONB support, not HTTP JSON transport.
* exact feature set should be audited before publishing v0.

Rationale:

SQLx provides mature async database access and fits Axum/Tokio applications well. CrateStack needs dynamic query construction for filters and policy injection, making SQLx `QueryBuilder` a good match.

Decision:

Use SQLx as the v0 database backend.

---

## 6.2 `sea-query`

Status: DEFER

Purpose considered:

* SQL AST construction
* database-agnostic SQL generation

Rationale for deferral:

CrateStack v0 targets PostgreSQL only. SQLx `QueryBuilder` is sufficient for v0 dynamic SQL generation. Adding SeaQuery now would add another abstraction layer before the SQL model is stable.

Decision:

Do not use SeaQuery in v0. Reconsider when multi-database support is planned.

---

## 6.3 `diesel`

Status: REJECT FOR v0

Purpose considered:

* compile-time query safety
* mature ORM-like Rust database access

Rationale for rejection:

CrateStack needs generated dynamic filters, policy injection, and REST-driven query construction. SQLx provides a more direct async execution model for this architecture.

Decision:

Do not use Diesel in v0.

---

## 6.4 `sea-orm`

Status: REJECT FOR v0

Purpose considered:

* higher-level ORM over SeaQuery
* entity model generation

Rationale for rejection:

CrateStack itself is an ORM/codegen layer. Depending on another ORM would blur responsibility and restrict policy/query generation control.

Decision:

Do not use SeaORM in v0.

---

# 7. HTTP and REST Dependencies

## 7.1 `axum`

Status: ADOPT

Purpose:

* v0 HTTP framework
* generated REST routes
* extractors
* request extensions
* response conversion

Used by:

* `cratestack-axum`
* generated route code
* examples

Recommended dependency:

```toml
axum = { version = "0.8", default-features = false, features = [
  "tokio",
  "http1",
  "http2",
  "query",
  "matched-path"
] }
```

Do not enable `json` unless `cratestack-codec-json` or examples specifically require it.

Rationale:

Axum is ergonomic, Tokio-native, Tower-based, and has a strong extractor model. It is a good fit for generated REST routes.

Decision:

Adopt Axum as the only supported HTTP framework in v0.

---

## 7.2 `tower`

Status: ADOPT OPTIONAL

Purpose:

* middleware compatibility
* service abstractions
* potential auth/context extraction layer

Used by:

* `cratestack-axum`

Recommended dependency:

```toml
tower = "0.5"
```

Rationale:

Axum is Tower-based. CrateStack integrations may need Tower layers for context propagation, request processing, or middleware helpers.

Decision:

Use where necessary in `cratestack-axum`, but avoid exposing unnecessary Tower complexity in the public API.

---

## 7.3 `tower-http`

Status: DEFER

Purpose considered:

* tracing middleware
* compression
* CORS
* request ID middleware

Rationale for deferral:

These are application-level concerns and should not be forced into CrateStack core. Examples may use `tower-http`, but generated routes should not require it.

Decision:

Do not require `tower-http` in v0 library crates. Use only in examples if helpful.

---

# 8. Parser and Diagnostics Dependencies

## 8.1 `chumsky`

Status: ADOPT

Purpose:

* `.cstack` schema parser
* parser combinators
* source spans
* recoverable parse errors

Used by:

* `cratestack-parser`

Recommended dependency:

```toml
chumsky = "0.10"
```

Rationale:

CrateStack needs a custom schema language with good diagnostics. Chumsky is well suited for expressive parser construction and error recovery.

Decision:

Use Chumsky for the v0 parser.

Risk:

Complex Chumsky parsers can produce difficult Rust compiler errors during parser development.

Mitigation:

* isolate parser grammar in `cratestack-parser`
* keep parser modules small
* maintain extensive parser tests
* snapshot parser errors

---

## 8.2 `ariadne`

Status: ADOPT

Purpose:

* compiler-style diagnostic rendering
* source span labels
* CLI and macro diagnostics support

Used by:

* `cratestack-parser`
* `cratestack-cli`
* possibly `cratestack-macros`

Recommended dependency:

```toml
ariadne = "0.6"
```

Rationale:

`.cstack` needs clear schema diagnostics. Ariadne produces readable source-highlighted error reports.

Decision:

Use Ariadne for human-readable diagnostics.

---

## 8.3 `miette`

Status: WATCH / DEFER

Purpose considered:

* structured diagnostics
* pretty terminal reports
* source spans
* CLI error handling

Rationale for deferral:

Ariadne is already selected for source diagnostics. Adding Miette now may duplicate responsibilities. However, Miette may be useful for CLI-level error aggregation later.

Decision:

Do not adopt in v0 core. Reconsider for `cratestack-cli` if Ariadne alone is not sufficient.

---

## 8.4 `pest`

Status: REJECT FOR v0

Purpose considered:

* grammar-driven parser

Rationale for rejection:

Pest is a strong parser option, but Chumsky gives more direct Rust-level composition and parser recovery flexibility for the planned compiler-style pipeline.

Decision:

Use Chumsky, not Pest, for v0.

---

## 8.5 `winnow`

Status: WATCH

Purpose considered:

* high-performance parser combinators

Rationale:

Winnow is a strong parser ecosystem option, but Chumsky better matches the initial need for rich diagnostics and custom language ergonomics.

Decision:

Do not use in v0. Reconsider if parser performance becomes a problem.

---

# 9. Procedural Macro and Code Generation Dependencies

## 9.1 `proc-macro2`

Status: ADOPT

Purpose:

* stable token stream manipulation outside compiler proc-macro API

Used by:

* `cratestack-macros`
* `cratestack-codegen` if separated

Recommended dependency:

```toml
proc-macro2 = "1"
```

Decision:

Adopt for macro/codegen internals.

---

## 9.2 `quote`

Status: ADOPT

Purpose:

* generate Rust token streams

Used by:

* `cratestack-macros`
* `cratestack-codegen`

Recommended dependency:

```toml
quote = "1"
```

Decision:

Adopt for Rust code generation.

---

## 9.3 `syn`

Status: ADOPT

Purpose:

* parse macro input
* parse literal schema path
* possible future macro options

Used by:

* `cratestack-macros`

Recommended dependency:

```toml
syn = { version = "2", features = ["full"] }
```

Rationale:

`include_schema!` initially only needs a string literal, but future macro configuration may need more parsing. `syn` is the standard proc-macro parsing library.

Decision:

Adopt for macro input parsing.

---

## 9.4 `prettyplease`

Status: ADOPT OPTIONAL

Purpose:

* format generated code for debug output
* potential `cratestack print-code` CLI command

Used by:

* `cratestack-cli`
* codegen debug tooling

Recommended dependency:

```toml
prettyplease = "0.2"
```

Rationale:

Macro-generated code can be hard to debug. Pretty-printing generated Rust can make diagnostics and issue reports much easier.

Decision:

Do not require at runtime. Use in CLI/debug tooling.

---

# 10. Codec Dependencies

## 10.1 `minicbor-serde`

Status: ADOPT

Purpose:

* CBOR encoding and decoding through Serde
* first-class CrateStack codec implementation

Used by:

* `cratestack-codec-cbor`
* possibly `cratestack-cose` indirectly

Recommended dependency:

```toml
minicbor-serde = { version = "0.6", features = ["std"] }
```

Rationale:

`minicbor-serde` provides Serde-compatible CBOR serialization/deserialization on top of `minicbor` and aligns with the planned generic `CoolCodec` trait while keeping the door open to lower-level `minicbor` control where needed.

Decision:

Use `minicbor-serde` for the official CBOR codec.

---

## 10.2 `serde_json`

Status: ADOPT OPTIONAL

Purpose:

* optional JSON codec
* examples if needed
* debugging utilities

Used by:

* `cratestack-codec-json`
* tests/examples only

Recommended dependency:

```toml
serde_json = "1"
```

Rationale:

Some developers may want JSON. However, JSON must not be required by CrateStack core and must not be assumed by generated handlers.

Decision:

Provide optional JSON support in a separate crate or feature. Do not place it in core.

---

## 10.3 `serde_cbor`

Status: REJECT FOR v0

Purpose considered:

* CBOR encoding/decoding through Serde

Rationale for rejection:

`minicbor-serde` is preferred for the official CBOR codec.

Decision:

Do not use `serde_cbor` in v0.

---

## 10.4 `minicbor`

Status: ADOPT SUPPORTING

Purpose considered:

* CBOR encoding/decoding
* lower-level CBOR control

Rationale:

CrateStack uses `minicbor-serde` for Serde-based CBOR transport and keeps `minicbor` available as the underlying low-level codec when sequence-aware or lower-level CBOR handling is needed.

Decision:

Do not use in v0 official codec. Reconsider for advanced codec crates later.

---

# 11. COSE and Cryptography Dependencies

## 11.1 `coset`

Status: ADOPT OPTIONAL

Purpose:

* COSE structure handling
* CoseSign1 support
* CBOR Object Signing and Encryption data model

Used by:

* `cratestack-cose`

Recommended dependency:

```toml
coset = "0.4"
```

Rationale:

Coset provides Rust types for COSE and builds on Ciborium. It gives CrateStack a structured way to implement COSE envelope modes without treating COSE as a codec.

Decision:

Use Coset for `cratestack-cose`.

---

## 11.2 Signature Algorithm Crates

Status: DEFER / ADOPT OPTIONAL PER ALGORITHM

Purpose:

* implement actual signing and verification for selected COSE algorithms

Candidate crates:

```toml
ed25519-dalek = "2"
p256 = "0.13"
p384 = "0.13"
sha2 = "0.10"
```

Rationale:

Coset models COSE structures but applications still need concrete cryptographic signing and verification implementations. CrateStack should not prematurely commit to a broad cryptography suite.

Decision:

For v0, define a signer/verifier trait boundary in `cratestack-cose`. Add concrete algorithm adapters only when required by a target deployment.

Recommended initial algorithm if one must be selected:

```text
Ed25519 / EdDSA
```

Reason:

* compact signatures
* common modern choice
* simpler operational profile than ECDSA in many contexts

Risk:

COSE deployments may require ES256, ES384, or other algorithms for interoperability.

Mitigation:

Keep algorithm implementation behind traits.

---

## 11.3 `cose-rust`

Status: WATCH / REJECT FOR INITIAL v0

Purpose considered:

* higher-level COSE message encode/decode support

Rationale:

`cose-rust` may provide useful examples and message support, but `coset` is the preferred initial choice because it is strongly aligned with Ciborium and provides structured COSE types.

Decision:

Do not use as the initial COSE dependency. Reconsider if `coset` proves insufficient.

---

## 11.4 `secrecy`

Status: ADOPT OPTIONAL

Purpose:

* protect secret key material in memory APIs
* avoid accidental debug logging of secrets

Used by:

* `cratestack-cose`
* application examples involving keys

Recommended dependency:

```toml
secrecy = "0.10"
```

Decision:

Use in COSE key handling APIs if private key material is accepted directly by CrateStack-owned types.

---

## 11.5 `zeroize`

Status: ADOPT OPTIONAL

Purpose:

* zero memory for secret material

Used by:

* `cratestack-cose`

Recommended dependency:

```toml
zeroize = "1"
```

Decision:

Use when CrateStack stores or manipulates secret key bytes.

---

# 12. Date, Time, ID, and Value Dependencies

## 12.1 `uuid`

Status: ADOPT

Purpose:

* support `Uuid` schema scalar
* database UUID fields
* transport serialization

Used by:

* generated schema code
* `cratestack-core`
* `cratestack-sqlx`

Recommended dependency:

```toml
uuid = { version = "1", features = ["serde", "v4"] }
```

Decision:

Adopt for the `Uuid` scalar.

---

## 12.2 `chrono`

Status: ADOPT WITH CAUTION

Purpose:

* support DateTime values
* SQLx integration

Used by:

* generated schema code
* `cratestack-sqlx`

Recommended dependency:

```toml
chrono = { version = "0.4", features = ["serde"] }
```

Rationale:

Chrono remains widely used and SQLx support is mature.

Decision:

Use Chrono initially for `DateTime`, unless the team decides to standardize on `time` before implementation.

---

## 12.3 `time`

Status: WATCH / POSSIBLE SUBSTITUTE FOR CHRONO

Purpose considered:

* modern date/time types
* SQLx integration

Recommended dependency if selected:

```toml
time = { version = "0.3", features = ["serde"] }
```

Rationale:

The `time` crate is a strong modern alternative to Chrono.

Decision:

Do not support both `chrono` and `time` in generated public model types in v0. Pick one before implementation. Default recommendation: use Chrono for ecosystem compatibility unless the team strongly prefers `time`.

---

## 12.4 `indexmap`

Status: ADOPT OPTIONAL

Purpose:

* preserve schema declaration order
* deterministic codegen
* stable diagnostics

Used by:

* `cratestack-core`
* parser/analyzer
* codegen

Recommended dependency:

```toml
indexmap = { version = "2", features = ["serde"] }
```

Rationale:

Schema order matters for diagnostics and predictable generated code. `IndexMap` is useful for preserving insertion order while enabling lookup.

Decision:

Use if the IR benefits from ordered maps. Otherwise use vectors plus explicit lookup maps.

---

# 13. CLI Dependencies

## 13.1 `clap`

Status: ADOPT

Purpose:

* `cratestack check`
* `cratestack print-ir`
* future commands

Used by:

* `cratestack-cli`

Recommended dependency:

```toml
clap = { version = "4", features = ["derive"] }
```

Rationale:

Clap is the standard Rust CLI argument parser and is suitable for long-term command growth.

Decision:

Use Clap for CLI.

---

## 13.2 `camino`

Status: ADOPT OPTIONAL

Purpose:

* UTF-8 path handling in CLI and macro helpers

Used by:

* `cratestack-cli`
* possibly parser diagnostics

Recommended dependency:

```toml
camino = "1"
```

Rationale:

Schema tooling benefits from predictable UTF-8 paths.

Decision:

Use if path handling becomes verbose or error-prone with `std::path`.

---

# 14. Testing Dependencies

## 14.1 `insta`

Status: ADOPT

Purpose:

* snapshot parser diagnostics
* snapshot generated SQL
* snapshot generated Rust debug output
* snapshot IR

Used by:

* parser tests
* policy tests
* codegen tests

Recommended dependency:

```toml
insta = { version = "1", features = ["yaml"] }
```

Rationale:

CrateStack is a compiler/codegen project. Snapshot testing is highly valuable for generated output and diagnostics.

Decision:

Use Insta for snapshots.

---

## 14.2 `pretty_assertions`

Status: ADOPT OPTIONAL

Purpose:

* readable diff output in tests

Used by:

* unit tests

Recommended dependency:

```toml
pretty_assertions = "1"
```

Decision:

Use in tests where diffs are helpful.

---

## 14.3 `testcontainers`

Status: ADOPT OPTIONAL

Purpose:

* PostgreSQL integration tests
* full SQLx/REST tests

Used by:

* integration tests

Recommended dependency:

```toml
testcontainers = "0.24"
```

Rationale:

Integration tests need real PostgreSQL behavior. Testcontainers provides repeatable test databases.

Decision:

Use for integration tests if CI can support Docker. Otherwise provide a `DATABASE_URL`-driven test mode.

---

## 14.4 `reqwest`

Status: ADOPT OPTIONAL

Purpose:

* end-to-end HTTP tests
* Rust generated-client runtime for CrateStack service-to-service calls

Used by:

* integration tests
* `cratestack-client-rust`, which backs generated Rust clients emitted by `include_server_schema!` and client-only generated clients emitted by `include_client_schema!` (renamed from `include_client_macro!` in 0.3.0)

Recommended dependency:

```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
```

Rationale:

Useful for black-box HTTP tests, though Axum services can also be tested through Tower service calls. It is also the HTTP transport for generated Rust clients, including backend-to-backend callers that include only another service's client surface.

Decision:

Use in `cratestack-client-rust` and in black-box HTTP integration tests. Prefer the generated client facade over handwritten `reqwest` calls when the target service exposes a CrateStack `.cstack` schema.

---

# 15. Development Tooling Dependencies

## 15.1 `rustfmt`

Status: ADOPT VIA TOOLCHAIN

Purpose:

* format source code
* format generated code snapshots where applicable

Decision:

Require stable rustfmt in CI.

---

## 15.2 `clippy`

Status: ADOPT VIA TOOLCHAIN

Purpose:

* lint library and generated code where possible

Decision:

Run Clippy in CI.

---

## 15.3 `cargo-deny`

Status: ADOPT

Purpose:

* license checks
* advisory checks
* duplicate dependency detection
* banned dependency enforcement

Decision:

Use `cargo-deny` before first public release.

---

## 15.4 `cargo-audit`

Status: ADOPT OPTIONAL

Purpose:

* RustSec advisory checks

Decision:

Use either `cargo-audit` directly or through `cargo-deny`. Avoid duplicate CI noise if `cargo-deny` covers advisories.

---

# 16. Dependency Feature Matrix

## 16.1 `cratestack-core`

Required:

```toml
serde = { version = "1", features = ["derive"] }
thiserror = "2"
bytes = "1"
http = "1"
uuid = { version = "1", features = ["serde"] }
chrono = { version = "0.4", features = ["serde"] }
```

Optional:

```toml
tracing = "0.1"
indexmap = { version = "2", features = ["serde"] }
```

Must not depend on:

```text
axum
sqlx
serde_json
minicbor-serde
coset
```

Exception:

If generated public model types directly require SQLx traits, SQLx should be used in generated code or `cratestack-sqlx`, not `cratestack-core`.

---

## 16.2 `cratestack-parser`

Required:

```toml
chumsky = "0.10"
ariadne = "0.6"
thiserror = "2"
```

Optional:

```toml
insta = { version = "1", features = ["yaml"] }
```

---

## 16.3 `cratestack-macros`

Required:

```toml
proc-macro2 = "1"
quote = "1"
syn = { version = "2", features = ["full"] }
```

Internal path dependencies:

```toml
cratestack-parser = { path = "../cratestack-parser" }
cratestack-core = { path = "../cratestack-core" }
cratestack-policy = { path = "../cratestack-policy" }
```

Optional:

```toml
prettyplease = "0.2"
```

---

## 16.4 `cratestack-sqlx`

Required:

```toml
sqlx = { version = "0.8", default-features = false, features = [
  "runtime-tokio",
  "postgres",
  "uuid",
  "chrono",
  "json"
] }
thiserror = "2"
tracing = "0.1"
```

---

## 16.4.1 `cratestack-redis`

Required:

```toml
redis = { version = "1", features = ["aio", "tokio-comp", "script"] }
async-trait = "0.1"
sha2 = "0.10"
uuid = { version = "1", features = ["v4"] }
cratestack-axum = { path = "../cratestack-axum" }
cratestack-core = { path = "../cratestack-core" }
```

Notes:

Sibling crate to `cratestack-sqlx` on the server side: ships
`RedisIdempotencyStore`, the Redis-backed `IdempotencyStore` impl used
by `IdempotencyLayer`. Lua scripts handle atomicity; `PEXPIREAT` handles
eviction. Distinct from the client-side `cratestack-client-store-redis`,
which implements `ClientStateStore` and is independent of this crate.

---

## 16.5 `cratestack-axum`

Required:

```toml
axum = { version = "0.8", default-features = false, features = [
  "tokio",
  "http1",
  "http2",
  "query",
  "matched-path"
] }
tower = "0.5"
bytes = "1"
http = "1"
```

Must not require:

```text
axum/json feature
serde_json
```

---

## 16.6 `cratestack-codec-cbor`

Required:

```toml
minicbor-serde = { version = "0.6", features = ["std"] }
serde = { version = "1", features = ["derive"] }
```

---

## 16.7 `cratestack-codec-json`

Required:

```toml
serde_json = "1"
serde = { version = "1", features = ["derive"] }
```

Notes:

This crate is optional and must not be pulled by default.

---

## 16.8 `cratestack-cose`

Required:

```toml
coset = "0.4"
bytes = "1"
thiserror = "2"
```

Optional per implementation:

```toml
ed25519-dalek = "2"
p256 = "0.13"
p384 = "0.13"
sha2 = "0.10"
secrecy = "0.10"
zeroize = "1"
```

Recommendation:

Start with COSE structure support and signer/verifier traits. Add concrete crypto algorithm crates only when implementing a specific envelope mode.

---

## 16.9 `cratestack-cli`

Required:

```toml
clap = { version = "4", features = ["derive"] }
anyhow = "1"
ariadne = "0.6"
```

Optional:

```toml
camino = "1"
prettyplease = "0.2"
```

---

# 17. Initial Cargo Feature Strategy

## 17.1 Root `cratestack` Features

Recommended root features:

```toml
[features]
default = ["postgres", "axum", "cbor"]
postgres = ["dep:cratestack-sqlx"]
axum = ["dep:cratestack-axum"]
cbor = ["dep:cratestack-codec-cbor"]
json = ["dep:cratestack-codec-json"]
cose = ["dep:cratestack-cose"]
```

Potential stricter default for CBOR-first projects:

```toml
[features]
default = []
```

Then applications opt in explicitly:

```toml
cratestack = { version = "0.1", default-features = false, features = ["postgres", "axum", "cbor"] }
```

Recommendation:

For early internal development, use `default = []` to prevent accidental JSON assumptions and keep dependency boundaries honest.

Before public release, decide whether defaults should optimize for general adoption or strict minimalism.

Implementation note:

The workspace bootstrap in this repo adopts `default = []`.

---

# 18. Rejected Dependencies Summary

## 18.1 Rejected for v0

```text
Diesel
SeaORM
Pest
serde_cbor
```

## 18.2 Deferred

```text
SeaQuery
Miette
Tower HTTP
Migration-specific crates
Multi-database query abstraction crates
```

## 18.3 Watch List

```text
Winnow
Minicbor
cose-rust
Miette
Time crate as Chrono replacement
```

---

# 19. Security Review Notes

Dependencies requiring special security attention:

```text
coset
ed25519-dalek / p256 / p384 / sha2
sqlx
minicbor-serde
axum/hyper/tower
```

Required controls:

1. Run `cargo-deny` in CI.
2. Run RustSec advisory checks.
3. Review cryptography dependencies before enabling COSE signing/encryption in production.
4. Keep COSE key handling behind traits.
5. Avoid storing secret key material in long-lived CrateStack structs unless necessary.
6. Use `secrecy` and `zeroize` if private key bytes are handled.
7. Snapshot-test policy SQL generation.
8. Ensure all SQL uses bind parameters.
9. Keep JSON optional and out of core.
10. Validate unsupported content types explicitly.

---

# 20. Licensing Policy

Before first public release:

1. Configure `cargo-deny` license policy.
2. Allow permissive licenses such as MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, and Unicode-3.0 if needed.
3. Review crypto crate licenses manually.
4. Review transitive dependencies for GPL/AGPL/LGPL restrictions.
5. Add a dependency approval step for new public dependencies.

---

# 21. Version Pinning Policy

For library crates:

* use semver-compatible version ranges in `Cargo.toml`
* do not pin exact patch versions unless necessary
* use `Cargo.lock` for reproducible workspace builds

For examples and templates:

* use compatible major/minor versions
* regenerate lockfiles regularly

For security-sensitive crates:

* update promptly on advisories
* document any temporary pins

---

# 22. Dependency Review Checklist

Every new dependency must answer:

1. Which crate owns this dependency?
2. Is this dependency required or optional?
3. Does it belong in core?
4. Does it pull JSON into core?
5. Does it pull Axum into core?
6. Does it pull SQLx into core?
7. Does it affect public generated types?
8. Does it affect MSRV?
9. Does it introduce unsafe code?
10. Does it introduce cryptography?
11. Does it introduce native dependencies?
12. What is the license?
13. Is it actively maintained?
14. Are there viable alternatives?
15. How will it be tested?

---

# 23. Recommended Initial Dependency Set

For the first implementation sprint, start with only:

```toml
serde = { version = "1", features = ["derive"] }
thiserror = "2"
bytes = "1"
http = "1"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
async-trait = "0.1"
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "postgres", "uuid", "chrono"] }
axum = { version = "0.8", default-features = false, features = ["tokio", "http1", "query"] }
chumsky = "0.10"
ariadne = "0.6"
proc-macro2 = "1"
quote = "1"
syn = { version = "2", features = ["full"] }
minicbor-serde = { version = "0.6", features = ["std"] }
clap = { version = "4", features = ["derive"] }
insta = { version = "1", features = ["yaml"] }
```

Add later when needed:

```toml
coset = "0.4"
serde_json = "1"
tracing = "0.1"
tower = "0.5"
prettyplease = "0.2"
testcontainers = "0.24"
secrecy = "0.10"
zeroize = "1"
ed25519-dalek = "2"
p256 = "0.13"
sha2 = "0.10"
```

---

# 24. Final Dependency Decisions

For CrateStack v0, the team should proceed with these major decisions:

1. Use SQLx for database execution.
2. Use Axum for REST integration.
3. Use Tokio as the async runtime.
4. Use Chumsky for `.cstack` parsing.
5. Use Ariadne for schema diagnostics.
6. Use Serde as the generated type serialization contract.
7. Use `minicbor-serde` as the official Serde-based CBOR codec surface, with `minicbor` available for lower-level control.
8. Use Coset for optional COSE support.
9. Use `thiserror` for library errors.
10. Use `anyhow` only in CLI/examples/tests.
11. Use `quote`, `syn`, and `proc-macro2` for macro codegen.
12. Keep JSON optional and outside core.
13. Keep COSE optional and outside core.
14. Defer SeaQuery until multi-database support is designed.
15. Reject Diesel and SeaORM for v0.

## 24.1 Implementation Kickoff Decisions

The first repo implementation slice makes these choices explicit:

1. `chrono` is the initial `DateTime` type.
2. The implemented crates are `cratestack`, `cratestack-core`, `cratestack-parser`, `cratestack-policy`, `cratestack-macros`, `cratestack-codec-cbor`, `cratestack-codec-json`, `cratestack-axum`, `cratestack-cli`, and `cratestack-sqlx`.
3. `cratestack-axum` and `cratestack-codec-json` are implemented, while `cratestack-cose` remains deferred.
4. `cratestack-cli` prints the parsed IR with Rust debug formatting rather than a JSON renderer to keep JSON out of the initial dependency surface.
5. The current SQLx slice supports generated delegate scaffolding for `create`, `find_many`, `find_unique`, `update`, and `delete`, along with generated create/update input structs.
6. Generated SQL currently maps schema model and field names to snake_case SQL identifiers and uses naive pluralized snake_case table names.
7. `find_many` currently supports a minimal query IR: AND-combined `eq`, `ne`, `in`, string `contains`, string `starts_with`, boolean convenience filters, null-aware optional-field filters, explicit ordering, limit, and offset.
8. Generated field reference modules expose schema-specific helpers such as `cratestack_schema::post::published()` for the current filter/order API.
9. Generated create inputs currently omit `@id` and `@default(...)` fields, and generated update inputs emit only changed columns.
10. Read-policy support now exists for `@@allow(...)` and `@@deny(...)` rules on `find_many` / `find_unique`, with deny taking precedence over allow.
11. Canonical policy literals, predicates, relation quantifiers, and procedure-policy evaluation now live in `cratestack-policy`, which is shared by macro lowering and runtime enforcement.
12. The supported model-policy subset now includes list/detail read splits, recursive to-one traversal, dotted to-many quantifiers (`some` / `every` / `none`), nested auth paths, and create-time relation checks when the root join columns are available from create input or auth-derived defaults.
13. Create, update, and delete policy enforcement now exists for the same canonical policy surface; create checks run against generated input values plus auth context after applying `@default(auth().field)` defaults, and create-time relation checks can trigger DB lookups when the required join columns are known.
14. DB-backed integration coverage for policy enforcement now exists behind an env-gated test path using `CRATESTACK_TEST_DATABASE_URL`, and `cratestack/compose.yml` now provides a local PostgreSQL 18 target for that loop.
15. Procedure policy execution now exists through generated wrappers under `cratestack_schema::procedures::*`, supports grouped expressions plus nested `args.<field>` comparisons, and can delegate DB-backed row auth through `@authorize(Model, action, args.path)`.
16. Built-in `Page<T>` procedure returns now exist for declared model/type items, lower to a canonical `items` / `totalCount` / `pageInfo` envelope, and decode through the generated Rust and Dart client surfaces without introducing general schema generics.
17. Models can now opt into paged generated list responses with bare `@@paged`; that changes the generated top-level list route plus Rust/Dart `list(...)` and projection-driven `listView(...)` helpers to use `Page<Model>` / `Page<ProjectedModel>` while keeping non-paged models on plain array responses.
18. `CoolContext` now carries a structured principal surface with `actor`, `session`, `tenant`, and free-form claims while preserving legacy `auth().field` compatibility and exact-key-first lookup behavior.
19. Generated procedure registry traits now exist and currently use `Send` futures rather than a larger plugin/runtime abstraction.
20. Model-level `@@emit(created|updated|deleted)` directives now exist for the current narrow eventing slice; generated schema modules expose typed subscription helpers under `cratestack_schema::events`, generated SQLx `create` / `update` / `delete` paths now write matching envelopes into a transactional PostgreSQL outbox, and the generated event surface exposes an explicit drain hook for in-process delivery attempts.
21. A new `cratestack-axum` crate now provides minimal codec/body response helpers, and generated schema modules now expose `model_router`, `procedure_router`, and combined `router` helpers.
22. Generated Axum model routes now cover `GET`, `POST`, `PATCH`, and `DELETE` for generated model endpoints, with canonical `fields`, nested declared-relation `include` paths, canonical `sort`, `limit`, `offset`, scalar equality filters, and a small route-layer operator suffix set (`__ne`, `__lt`, `__lte`, `__gt`, `__gte`, `__in`, `__contains`, `__startsWith`, `__isNull`) on list routes, including `cuid`, UUID, and RFC3339 DateTime parsing. Legacy `orderBy` remains accepted as a compatibility alias for `sort`.
23. Generated list routes now accept canonical grouped `where=` expressions and can compile recursive relation filters such as `author.email=owner@example.com` or `user.sessions.some.label__startsWith=Primary` when the schema declares explicit `@relation(fields:[...],references:[...])` metadata.
24. The current grouped route grammar is contract-stable as `whereExpr := orExpr`, `orExpr := andExpr ("|" andExpr)*`, `andExpr := factor ("," factor)*`, and `factor := predicate | "(" whereExpr ")" | "not(" whereExpr ")"`. That means `not(...)` binds tighter than `,`, `,` binds tighter than `|`, and repeated `,` / `|` chains are left-associative unless parentheses override them. Legacy `or=` is still accepted only as a compatibility shortcut for a top-level OR list; canonical docs and new callers should prefer grouped `where=` because it is the only route form that supports nesting and unary negation.
25. To-many relation filters now require explicit quantifiers (`some`, `every`, `none`) instead of the earlier generic nested-path shape, relation metadata validation now rejects mismatched scalar types between `fields:[...]` and `references:[...]`, and the same relation/query surface has typed DSL parity through generated compatibility helpers and builder-style `FilterExpr` composition.
26. Generated list routes now support nested to-one relation-aware ordering such as `sort=author.email` or `sort=author.profile.nickname` through recursive correlated subqueries, and the generated model descriptor metadata now exposes per-resource allowed `fields`, `include`, and `sort` selections for route validation. Generated typed field modules still expose matching delegate helpers in both compatibility-function and builder-style forms. Delegate callers can use compatibility helpers such as `post::author::email_desc()` or builder paths such as `post::author().email().desc()` and `post::author().profile().nickname().eq(...)`. Generated typed field modules also expose quantified to-many filter paths such as `user::sessions().some().label().contains(...)`, while cycle-aware code generation stops repeating relation expansions like `user.sessions.some.user.sessions...`. `FilterExpr` now supports chainable `.and(...)` and `.or(...)` composition so the typed builder DSL can express grouped boolean filters without manually calling `FilterExpr::all(...)` or `FilterExpr::any(...)`. Missing related rows sort with explicit `NULLS LAST` behavior and the model primary key is auto-appended as a tie-break when the caller does not already specify it; any path that crosses a to-many relation remains intentionally unsupported for ordering, shallow `include` only materializes directly declared relations, and the generated Dart client now exposes canonical `fields` and `include` query options plus per-model field/include constant groups even though selection-aware response typing is still incomplete.
27. The generated HTTP layer now enforces a single configured codec through `Accept` and `Content-Type` header checks and uses dedicated `406` / `415` error variants rather than treating those mismatches as generic bad requests.
26. A new `cratestack-client-rust` spike now exercises CBOR-first client calls against generated Axum-compatible routes, exposes an FFI-ready safe-Rust runtime bridge, and persists a narrow request journal through an abstract state store with in-memory and JSON-file implementations.
27. `cratestack-client-store-sqlite` and `cratestack-client-store-redis` now provide opt-in durable request-journal and state-version store implementations for the client runtime.
26. A new `cratestack-client-flutter` crate now wraps the runtime bridge with byte-oriented safe-Rust APIs for Dart and Flutter callers without introducing raw pointer code into this workspace, but it does not yet expose persisted state or runtime-configurable SQLite selection through its public surface.
27. `cratestack-client-dart` now renders from repo-managed templates under its own `templates/` directory, the CLI can accept a template override directory so projects can customize emitted Dart without forking the generator crate, the generated Dart seam no longer exposes `CrateStackWireCodec`, and the emitted output is now a richer Flutter-style package scaffold rather than a single flat file.
28. The runtime bridge now treats bridge JSON bytes as an internal interop format while exposing runtime-wide transport config for `cbor` and `json`; COSE remains a reserved future envelope seam, and the generated Dart package still does not expose a typed remote-error surface.
29. The project-local client runtime architecture is documented in `../architecture/client-runtime.md`; a raw exported ABI wrapper, signing integration, a fully typed Rust-owned Dart bridge, persisted-state exposure, runtime-configurable SQLite selection, and eventual removal of the bridge JSON transcode remain follow-up work.
30. The current model HTTP surface still forwards directly into generated SQLx delegates and only exposes a narrow route-layer query subset rather than the full delegate filter DSL.
31. Richer policy parsing, broker/webhook fan-out, stronger event-delivery guarantees beyond the current transactional outbox plus in-process drain loop, and broader procedure runtime features are still deferred.
32. `cargo-deny` configuration is checked in at `cratestack/deny.toml` as part of the release-oriented workspace bootstrap.
33. Generated telemetry now uses direct `tracing` spans/events for procedure authorization and invocation, generated procedure routes, and generated model list routes, while subscriber setup, filtering, and any exporter integration remain host-owned concerns.
34. A new server-side `cratestack-redis` crate now provides `RedisIdempotencyStore`, a Redis-backed implementation of `cratestack_axum::idempotency::IdempotencyStore`. It writes one Redis hash per `(principal, key)` under `<prefix>:idem:<sha256(principal || 0x00 || key)>`, drives atomicity through three Lua scripts (`reserve_or_fetch`, `complete`, `release`) invoked via `EVALSHA` with a `NOSCRIPT` fallback, and uses `PEXPIREAT` for eviction instead of a separate GC sweep. The crate is a sibling to `cratestack-sqlx` — the client-side `cratestack-client-store-redis` keeps its existing scope (Redis-backed `ClientStateStore` for the generated Rust client's request journal) and is unrelated to this server-side store.

---

# 25. Open Dependency Questions

1. Should CrateStack standardize on `chrono` or `time` for `DateTime`?
2. Should the root crate have default features or require explicit opt-in?
3. Should `sqlx` macros be enabled in generated user dependencies or only in tests/examples?
4. Should COSE v0 include a concrete Ed25519 implementation or only signer/verifier traits?
5. Should JSON codec be shipped in v0 or delayed until after CBOR is stable?
6. Should `miette` replace or supplement Ariadne in CLI diagnostics?
7. Should generated code depend directly on SQLx derive macros, or should row decoding be centralized in `cratestack-sqlx`?
8. Should `tower` be exposed in public APIs or kept internal to `cratestack-axum`?

---

# 26. Immediate Action Items

1. Create workspace crate skeleton.
2. Add minimal dependency sets per crate.
3. Configure `cargo-deny`.
4. Configure CI for fmt, clippy, tests, and deny.
5. Implement parser spike with Chumsky.
6. Implement diagnostics spike with Ariadne.
7. Implement `CoolCodec` on top of the `minicbor-serde` / `minicbor` CBOR stack.
8. Implement macro spike with `include_schema!` reading a schema file.
9. Implement SQLx query spike using `QueryBuilder<Postgres>`.
10. Implement Axum binary-body route spike without enabling Axum JSON.
11. Defer COSE until the codec and envelope boundaries are proven.
