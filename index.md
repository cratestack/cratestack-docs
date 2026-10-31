---
layout: home
title: CrateStack
titleTemplate: false
description: Build typed services from one schema — server-side Postgres, embedded SQLite (mobile, desktop, browser-via-OPFS), or HTTP client — with generated delegates, routes, policy checks, and clients.

hero:
  name: CrateStack
  text: One schema in, three role-specific macros out
  tagline: Build typed services from one schema — server-side Postgres, embedded SQLite (mobile, desktop, browser-via-OPFS), or HTTP client — with generated delegates, routes, policy checks, and clients.
  image:
    src: /images/branding/cratestack-logomark.svg
    alt: The CrateStack mark, three stacked isometric crates
  actions:
    - theme: brand
      text: Start with the quickstart
      link: /getting-started/quickstart
    - theme: alt
      text: Check the verified scope
      link: /overview/current-state

features:
  - title: Start with the quickstart
    details: Stand up the smallest useful CrateStack service and see the generated runtime in a minimal Rust setup.
    link: /getting-started/quickstart
  - title: Check the verified scope
    details: See what the framework implements today, where it is already strong, and which parts are still intentionally deferred.
    link: /overview/current-state
  - title: Understand the auth boundary
    details: Keep authentication host-owned while still using generated policy enforcement inside the service runtime.
    link: /guides/auth-provider
  - title: Read the transport model
    details: Learn how CrateStack thinks about codecs, route generation, client boundaries across REST/RPC/gRPC, and remaining transport seams.
    link: /architecture/transport-architecture
  - title: Run the schema embedded
    details: Use the same <code>.cstack</code> schema against a local SQLite database — sync on mobile/desktop, persistent OPFS in the browser via <code>wasm32-unknown-unknown</code>.
    link: /guides/offline-first-sqlite
---

CrateStack is a schema-first Rust framework that turns one `.cstack` file into typed runtimes for three deployment shapes: a Postgres-backed server, an embedded SQLite ORM that works on mobile, desktop, **and browsers via OPFS**, and a HTTP client. One schema in, three role-specific macros out — each emits only what its target needs, no transitive sqlx in mobile builds, no rusqlite in server builds.

::: info
Define your service once in `.cstack`, then pick a macro: `include_server_schema!` for sqlx-backed Postgres servers, `include_embedded_schema!` for offline-capable apps (native sync, browser async via OPFS), or `include_client_schema!` for the generated Rust client. Each emits a `cratestack_schema` module shaped for that one role — Dart, TypeScript, and gRPC clients are generated separately via CLI subcommands.
:::

## Why CrateStack

CrateStack is built for teams that want framework leverage without giving up Rust ownership. You define the data model and policy surface once, and the framework handles the repetitive service plumbing around it.

- **What you author.** You write a `.cstack` schema that defines models, procedures, auth shape, mixins, and policy rules.
- **What gets generated.** CrateStack can generate SQLx-backed delegates, Axum CRUD and procedure routes, policy-aware runtime surfaces, and typed Rust or Dart clients.
- **Where it fits best.** The current slice is strongest for internal Rust services that want typed CRUD, generated contracts, and host-owned auth without building a custom framework from scratch.

## From Schema To Service

1. **Define the contract.** Model your auth principal, shared mixins, models, and policies in a `.cstack` file.
2. **Pick your macro.** Use `include_server_schema!("…", db = Postgres)` for the server, `include_embedded_schema!` for embedded ORM, or `include_client_schema!` for HTTP-only clients. Each validates the schema at compile time and emits a `cratestack_schema` module shaped for that role.
3. **Wire your runtime.** Server: build with a `sqlx::PgPool` and bind your application auth through the host-owned provider boundary. Embedded: open a `RusqliteRuntime` (native) or install OPFS first inside a Worker (browser). Client: construct a `CratestackClient` against the server's URL.
4. **Choose your surface area.** Use the generated delegates directly, mount generated Axum routers (server only), or do both depending on how much API surface you want exposed.

## What You Get Today

1. compile-time schema validation, split into three role-specific macros (`include_server_schema!` / `include_embedded_schema!` / `include_client_schema!`)
2. generated SQLx-backed model delegates (server) and rusqlite-backed delegates (embedded)
3. generated Axum CRUD and procedure routes (server)
4. generated policy enforcement for the supported subset (server only — embedded runtime is unauthenticated by design; clients are untrusted)
5. generated Rust, Dart, and TypeScript client surfaces
6. reusable schema mixins for shared field sets
7. banking-grade primitives: idempotency, optimistic locking, transactional audit, explicit transaction isolation (`run_in_isolated_tx`; the `@isolation` procedure attribute is ignored through 0.14.0 and enforced since 0.14.1, see [Transaction isolation](/guides/transaction-isolation#procedure-level-isolation)), soft delete, rate limiting, validators, Decimal scalar, forward-only migrations
8. embedded SQLite backend (`cratestack-rusqlite`) — sync API, bundled SQLite, exact-precision `Decimal` round-trip; works on **native** (mobile, desktop) and **`wasm32-unknown-unknown`** (browser, OPFS-backed) from the same source

::: warning
CrateStack is usable today, but the public `v0` track is narrower than the broader target architecture. COSE transport, parts of the client runtime, richer schema coverage, and some policy features are still deferred. Use [Current State](/overview/current-state) as the source of truth for adoption decisions.
:::

## Explore By Goal

<LinkCards>
  <LinkCard title="Evaluate adoption" href="/overview/current-state">
    Start here if you need a realistic view of the current feature set, maturity, and implementation boundaries.
  </LinkCard>
  <LinkCard title="Ship a first service" href="/getting-started/quickstart">
    Follow the minimal path from schema file to running Rust service with generated runtime pieces.
  </LinkCard>
  <LinkCard title="Adopt the banking-grade slice" href="/overview/banking-readiness">
    Review the idempotency, audit, optimistic-locking, isolation, and rate-limiting primitives shipped for regulated workloads.
  </LinkCard>
  <LinkCard title="Integrate host auth" href="/guides/auth-provider">
    Understand how principal data enters the runtime and where authorization remains framework-managed.
  </LinkCard>
  <LinkCard title="Check the reference surface" href="/reference/auth-support-matrix">
    Review the supported auth and policy combinations before designing around a capability that is not yet implemented.
  </LinkCard>
  <LinkCard title="Browse field attributes" href="/reference/field-attributes">
    The full <code>.cstack</code> field attribute surface, including exposure controls, validators, and <code>@version</code>.
  </LinkCard>
  <LinkCard title="Upgrading to 0.8.0?" href="/overview/migrating-to-0-8">
    The <code>Cool*</code> → <code>Cratestack*</code> rename and the new <code>decimal = ...</code> macro argument — both hard breaks, no deprecation window.
  </LinkCard>
</LinkCards>

## Repository Note

This documentation tree is a standalone VitePress project. The framework code itself lives in a separate CrateStack repository.

## Rust API Docs

Generated Rust API documentation is published at `https://rust-doc.cratestack.dev/`.
