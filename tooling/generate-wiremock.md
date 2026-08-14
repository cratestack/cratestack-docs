---
title: Generating WireMock stubs
description: Generate WireMock stub mappings from a .cstack schema so integration/e2e tests run against a mock backend whose wire contract can't drift from the real server.
---

# Generating WireMock Stubs

`cratestack generate-wiremock` reads a `.cstack` schema and writes [WireMock](https://wiremock.org/)
stub mappings — JSON files a WireMock instance loads to answer HTTP requests without a real server or
database behind it. The point is drift: a hand-maintained fixture (a JSON file someone wrote by hand
to fake an endpoint) silently stops matching reality the moment the schema changes; a generated one
doesn't compile until it's regenerated, the same guarantee `generate-dart`/`generate-typescript`
already give a real client.

This is a schema property, not a hypothetical: the motivating case was `ADORSYS-GIS/webank-mobile`'s
37 hand-maintained WireMock mapping files for its integration/e2e suite, each capable of drifting from
the real contract independently.

## What it covers

* Every `procedure`/`mutation procedure` — one static, happy-path stub each.
* Every `model` block's five CRUD routes — `list`/`get`/`create`/`update`/`delete`.
* **`transport rest` model CRUD is stateful.** A record created through a mocked `create` appears in
  a later `list`; a `PATCH` is visible on a later `get`; a `delete`d record's `get` returns `404`, not
  a stale body. This runs against a real per-record store
  (`wiremock-state-extension`), not a fixed example replayed on every request — see
  [Running the stateful stubs](#running-the-stateful-stubs) below before you build anything on it.
* **A model with `@version` gets real `If-Match` optimistic locking**, mirroring the real server's
  `crates/cratestack-axum/src/headers/etag.rs::parse_if_match_version` and
  `crates/cratestack-sqlx/src/query/write/update.rs` byte-for-byte — see
  [If-Match enforcement](#if-match-enforcement) below.
* `transport rpc` model CRUD and every procedure stay static/deterministic — see
  [What's still static](#whats-still-static).

## Usage

```bash
cratestack generate-wiremock \
  --schema schema.cstack \
  --out wiremock \
  --base-path /api
```

| Flag | Default | Meaning |
|---|---|---|
| `--schema` | — required | Path to the `.cstack` file |
| `--out` | — required | Output directory; mappings are written to `<out>/mappings/` |
| `--base-path` | `/api` | Prefix prepended to every stub's `urlPath` — must match the deployed server (and any generated client under test) |
| `--check` | off | Drift-detection mode: generate in memory and diff against `--out` instead of writing; exits non-zero and lists the files that differ |

This writes one file per procedure, `mappings/<procedureName>.json`, and — for a model — five files,
`mappings/model.<ModelName>.<list|get|create|update|delete>.json` (thirteen instead of five for a
`transport rest` model that declares `@version`: `update`/`delete` each fan out into the success file
plus four `-if-match-*` variant files). `mappings/` is the directory a WireMock instance scans by
convention, so `--out` can point directly at a project's existing WireMock root.

`--check` wires into CI the same way `generate-dart --check`/`generate-typescript --check` already do.
It works identically for the stateful stubs too: the generated *file content* (the Handlebars template
text) is fully deterministic even though what it renders to at request time isn't — two
`generate-wiremock` runs against an unchanged schema are byte-identical.

## Running the stateful stubs

This is the part a reader has to plan for before treating this as a drop-in mock server.

A `transport rest` schema's model CRUD stubs need `wiremock-state-extension` loaded, and **the
published jar doesn't work**: `docker run wiremock/wiremock` plus the extension's plain Maven Central
jar dropped into `/var/wiremock/extensions` throws `AbstractMethodError`/`NoSuchMethodError` on the
first request that touches stored state, against every `wiremock/wiremock` image tested. This is a
real, independently-corroborated upstream packaging defect (the extension's own issue #36) — every
`wiremock/wiremock` distribution relocates its bundled Handlebars package, and the extension's
published jar is compiled against the unrelocated one.

The extension's own build has the fix (a `shadowJar` Gradle task that relocates correctly), but that
artifact is never published anywhere — only the plain, broken jar ships to Maven Central. So the crate
ships a `Dockerfile` that builds the correctly-shaded jar from pinned source and layers it into a
`wiremock/wiremock` base image:

```bash
docker build -t my-org/wiremock-stateful \
  -f crates/cratestack-mock-wiremock/docker/Dockerfile \
  crates/cratestack-mock-wiremock/docker

docker run -p 8080:8080 \
  -v "$(pwd)/wiremock/mappings:/home/wiremock/mappings:ro" \
  my-org/wiremock-stateful
```

**Running the stateful stubs is a Docker build, not `docker run wiremock/wiremock`.** Versions are
pinned in the Dockerfile itself — see its header comment for what's pinned and why. Procedure stubs
and `transport rpc` model stubs don't need any of this; they work against a plain
`docker run wiremock/wiremock`.

## If-Match enforcement

For a model with no `@version` field, nothing changes — no header matching of any kind is emitted for
it. For a model that declares `@version`, `update`/`delete` each fan out into five gated stubs
mirroring the real server exactly:

| `If-Match` header | Status |
|---|---|
| absent | `412 Precondition Failed` |
| `If-Match: *` | `400 Bad Request` — explicitly unsupported on versioned models |
| present, not a strong quoted `"<integer>"` (unquoted, weak `W/"..."`, non-numeric) | `400 Bad Request` |
| well-formed but stale (doesn't match the stored version) | `412 Precondition Failed` |
| well-formed and current | `200`, version bumped, returned as a quoted `ETag` |

`DELETE` enforces the same precondition. `get`/`update` responses carry a matching
`ETag: "<version>"` header; `create`/`delete` never do, matching the real codegen. Error bodies mirror
`CratestackErrorResponse`'s `{code, message, details}` shape.

One simplification, stated plainly rather than silently approximated: **the real server produces two
distinct 400 messages** for a malformed `If-Match` (`parse_if_match_version` distinguishes "not
quoted at all" from "quoted but not an integer") — **this generator collapses both to one message**,
since a mock's header matching can't re-run the real function's two-step parse to tell them apart.

## What's still static

Stated honestly, because these are real ceilings, not oversights:

* **No list filtering, sorting, or pagination**, stateful or not. A `list` request returns the
  complete, unfiltered collection regardless of `field__operator=value`, `sort`, `limit`, or `offset`
  in the query string.
* **`transport rpc` model CRUD is entirely static** — one fixed example replayed on every request, no
  state, no `If-Match` preconditions of any kind, versioned model or not. The extension's per-record
  store needs something unique per request that REST gets for free (the id-bearing URL path) and RPC
  doesn't (the id lives in the request body).
* **`create` ignores a client-submitted primary key.** The mock always generates its own id, for every
  primary-key type (`Int`, `Uuid`, `Cuid`, plain `String`) — a submitted value satisfies the generated
  input type but is silently discarded. Every follow-up request must use the id the mock actually
  returned, not the one you sent.
* **No error-case stubs, no request-body assertion, no auth emulation.** A stub matches on method +
  path (+ the `If-Match` header where it applies) only; any request body is accepted.
* Fields outside `Required`-arity `String`/`Cuid`/`Uuid`/`Int`/`Float`/`Boolean`/`DateTime`/enum —
  i.e. `Optional`/`List` arity, `Json`/`Bytes`/`Vector(n)`, and nested `type` references — render a
  fixed example on every response, never reflecting what was actually created/patched. Relation
  fields and `@server_only` fields are excluded from every response entirely, same as the real
  server's default projection.

## Where generated stubs live

Not committed — gitignored and regenerated from the schema on every build, the same pattern already
used for generated Dart/TypeScript clients. Commit the `.cstack` schema (and a small script that runs
`generate-wiremock`), not the generated `mappings/*.json` files. `--check` lets CI enforce that the
committed schema and the stubs a test run agrees with actually match.

## A working example

[`examples/react-vite-refine`](https://github.com/cratestack/cratestack/tree/main/examples/react-vite-refine)
runs a real [refine.dev](https://refine.dev) admin app against a generated, stateful WireMock backend
end to end — schema → typed client → `@cratestack/refine` → live CRUD with optimistic locking, no
database, no hand-written server. See [refine.dev integration](../guides/refine-integration) for the
client side of that same example.

## Read Next

1. [refine.dev integration](../guides/refine-integration) — the client-side counterpart, including a
   runnable example that exercises these stubs live
2. [Optimistic Locking](../guides/optimistic-locking) — the full `@version`/`If-Match`/`ETag` contract
   this generator mirrors
3. [TypeScript client generation](../guides/typescript-client-generation) — the generated client this
   mock is typically tested against
4. [Installing the CLI](./cli-install) — get `cratestack` on your machine
