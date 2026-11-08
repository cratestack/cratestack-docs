---
title: "ADR 0023: Multi-file Schemas"
description: Split one .cstack schema across files with part / part of, and share types, enums and mixins between schemas with import.
---

# ADR 0023: Multi-file Schemas

## Status

Accepted. It was decided under delegation by the maintainer (@stephane-segning), who delegated
every decision of epic [cratestack#910](https://github.com/cratestack/cratestack/issues/910) on
2026-11-08, including the question
[cratestack#915](https://github.com/cratestack/cratestack/issues/915) reserved for the maintainer
(Q5 below).

## Date

2026-11-08

## Context

A `.cstack` schema is one file, and there is no way to share a definition between two schemas
except by copying it. The full context, with the mechanical constraints and `path:line`
evidence, is the design document
[`docs/design/multi-file-schemas.md`](https://github.com/cratestack/cratestack/blob/main/docs/design/multi-file-schemas.md).
This ADR records the decisions only.

## Decision

**D1. Two directives, two jobs.** A root lists its parts with `part "<path>"`, which is how files
are discovered and what keeps rebuild tracking explicit. Each part names its root with
`part of "<path>"`, which locks the part to that root and lets `import` refuse it. Both halves must
agree, and the error names both files. Parts share the root's single namespace. `datasource`,
`auth`, `transport` and `mcp` are allowed only in the root.

```cstack
// schema.cstack
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

part "schema/task.cstack"
```

```cstack
// schema/task.cstack
part of "../schema.cstack"

model Task {
  id Int @id
  title String
}
```

**D2. `import "<path>"` shares types, and is flat, transitive and deduplicated.**

| Question (cratestack#915) | Decision | Rejected |
|---|---|---|
| Q1 flat or namespaced | Flat: one namespace. A collision is an error naming both files. | `import … as ns`: every generator would need a mangling scheme. Adding it later is non-breaking. |
| Q2 transitive | Yes | Non-transitive plus re-export: it hides nothing in a flat namespace, and it is a second feature. |
| Q3 diamonds | Loaded once, keyed by `std::fs::canonicalize` (resolves `..` and symlinks) | Dedupe by the path as written: two spellings would collide with themselves. |
| Q4 cycles | Refused, with the full cycle in the message | — |
| Q5 do imported models create tables | **No.** An imported file may declare only `type`, `enum` and `mixin`. Use `part` to split a schema's models. | Imported models as full models, so each importer owns a copy of the table: it couples services through a shared file. Allowing models later is non-breaking, and forbidding them later would be breaking. |

**D3. Paths are relative to the file containing the directive.** They must be relative, use `/`
and end in `.cstack`. The macro argument stays `CARGO_MANIFEST_DIR`-relative.

**D4. Splitting changes nothing.** Files load in a documented order: the root, then its parts in
listed order, then each file's imports in order, each loaded once. The merged IR equals the IR of
the files concatenated in that order, with source positions excluded. `SCHEMA_SHA256` is
unchanged, and `migrate diff` sees no difference.

**D5. Generated surface.** `SCHEMA_SOURCE` stays the root file's text. A schema spanning more
than one file also gets `SCHEMA_FILES: &[(&str, &str)]`, one `include_str!` per file, which is
what makes every file a rebuild dependency. A single-file schema's generated output is
byte-identical to before.

## Consequences

- A schema can be split with no change to generated code, migrations, or the drift fingerprint.
- A file that declares `part of` but that no root lists is not read by any build. `cratestack
  check` and the LSP report it when that file is opened or checked. A build cannot report it
  without globbing, which D1 exists to avoid.
- Two services can share value types without copying them. They cannot share tables through
  `import`.
- The LSP refuses rename in a schema split across files until cross-file rename lands.
