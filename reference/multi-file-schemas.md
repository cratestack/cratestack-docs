---
title: Multi-file Schemas
description: Split one .cstack schema across files with part / part of, and share types, enums and mixins between schemas with import. Since 0.19.0.
---

# Multi-file Schemas

*(since 0.19.0)* A `.cstack` schema no longer has to be one file. Three top-level directives cover two
different jobs:

```cstack
part "models/post.cstack"        // in a root: this file is more of me
part of "../schema.cstack"       // in a part: I belong to that root
import "../shared/money.cstack"  // anywhere: bring in a shared file's types
```

Each directive takes one line, a double-quoted path and nothing after it (no trailing comment). Directives
may appear anywhere at top level; putting them first is the documented style. `part`, `part of` and `import`
remain reserved words, so they still cannot name a model, field or any other identifier.

The decisions behind this page, with the alternatives that were rejected, are in
[ADR 0023](../internals/multi-file-schemas-adr).

## Split one schema with `part`

The **root** is the file you point the macro or the CLI at. It lists its parts with `part "<path>"`. Each
part starts with `part of "<path>"`, naming that root. Both halves must agree, and the error names both
files when they do not.

The `react-vite-swr` example ships split this way. Its
[root](https://github.com/cratestack/cratestack/blob/main/examples/react-vite-swr/schema.cstack):

```cstack
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

auth Caller {
  id Int
}

part "schema/board.cstack"
part "schema/task.cstack"
part "schema/procedures.cstack"
```

and one of its parts,
[`schema/task.cstack`](https://github.com/cratestack/cratestack/blob/main/examples/react-vite-swr/schema/task.cstack):

```cstack
part of "../schema.cstack"

model Task {
  id Int @id
  title String
  done Boolean
  boardId Int
  board Board @relation(fields:[boardId],references:[id])

  @@allow("read", auth() != null)
  @@allow("create", auth() != null)
  @@allow("update", auth() != null)
  @@allow("delete", auth() != null)
}
```

`Board` is declared in `schema/board.cstack` and resolves here: a root and its parts share one flat
namespace. A part is locked to its root. It is not a schema on its own, and a macro or command that is
pointed at a part is refused (see [Tooling](#tooling) for the one exception).

Parts are one level deep: a part cannot list parts of its own.

## Share types with `import`

`import` is for a shape that several schemas use. The imported file belongs to nobody (it has no
`part of`), so any number of schemas may import it:

```cstack
// shared/money.cstack
enum Currency {
  EUR
  XAF
}

type Money {
  amount Decimal
  currency Currency
}

mixin Timestamps {
  createdAt DateTime @default(now())
  updatedAt DateTime @default(now())
}
```

```cstack
// billing/schema.cstack
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

import "../shared/money.cstack"

model Invoice {
  @use(Timestamps)

  id Int @id
  total Decimal
  currency Currency
}

type QuoteResult {
  price Money
}
```

The imported declarations join the importer's single namespace. There is no `as`, `show` or `hide`, and
imports are transitive: if `billing` imports `money` and `money` imports `base`, `billing` sees `base`'s
declarations. A name declared in two files is an error that names both. A file reached by two routes
(`main` imports `a` and `b`, which both import `c`) is loaded once, whichever way each route spells the
path.

### What an import may contain

An imported file, and every part of an imported root, may declare **`type`, `enum` and `mixin`**, plus the
directives. A `model`, `view`, any kind of `procedure`, `topic`, `query`, `extension` and the root-only
declarations are refused with an error that names the declaration and the import.

The reason is ownership. An imported model would create a table, routes and policies in every importer,
so one shared file would couple several services' databases and migrations. Types, enums and mixins carry
a *shape* and leave the storage to the importer: two services importing `money.cstack` each generate their
own `Money` struct, wire-compatible because they have the same shape; an imported enum used by a model
column is materialized in the importer's own migrations; a mixin's fields are copied into the importer's
model by `@use`, as if they were written there. To split one schema's models across files, use `part`.
Relaxing this rule later would be additive, so it ships in its narrow form first.

`extension` is refused too, on purpose: an extension unlocks syntax tied to a Cargo feature of the
consuming crate, and a file someone else maintains must not switch a capability on in your build. A shared
type that needs `Vector(n)` needs the importer to declare `extension pgvector { }`.

### An imported file cannot be a part

An imported file may not declare `part of`. A part is locked to its root, and the import rule is how that
lock is enforced: importing a file that says `part of` is refused with an error naming both files. Import
a file that does not declare `part of` instead.

## When to use which

|  | `part` / `part of` | `import` |
| --- | --- | --- |
| Belongs to | exactly one root | nobody; any number of schemas |
| May contain | anything a root may, except the root-only declarations below | `type`, `enum`, `mixin` only |
| Use it to | split one schema into files | share value shapes between schemas |

## Where each declaration may go

| Declaration | Root | Part | Imported file, or a part of one |
| --- | --- | --- | --- |
| `datasource`, `auth`, `transport`, `mcp { }` | yes | no | no |
| `model`, `view`, `procedure`, `mutation procedure`, `subscription procedure`, `topic`, `query` | yes | yes | no |
| `extension <name> { }` | yes | yes (merged by union) | no |
| `type`, `enum`, `mixin` | yes | yes | yes |
| `part "…"` | yes | no | in an imported root only |
| `part of "…"` | no | exactly once | in a part of an imported root |
| `import "…"` | yes | yes | yes |

`datasource`, `auth`, `transport` and `mcp` are root-only singletons: a part that declared one would make
"which one wins" depend on file order.

## Paths

- A path is **relative to the directory of the file that contains the directive**. In
  `schema/task.cstack`, `part of "../schema.cstack"` names `schema.cstack`.
- It must be relative, use `/` as its only separator, and end in `.cstack`.
- The argument of `include_*_schema!` stays relative to `CARGO_MANIFEST_DIR`, and a CLI `--schema` stays
  relative to the working directory. Both name the **root**.
- Every directive resolves against the directory of the **canonical (real) path** of the file that holds it,
  and `..` is left to the operating system rather than folded first. A symlinked file therefore resolves its
  own `part` and `import` lines from where it really is, whichever spelling loaded it, and a symlinked part's
  `part of` is written relative to its real location.
- The root is shown as you gave it; every other file is shown at its real location relative to the root's
  real directory, so a displayed path always names a file that exists.
- Files outside the crate directory (`import "../../shared/money.cstack"`) work inside a workspace. But
  `cargo publish` packages only the crate directory, so a published crate must keep its schema files
  inside it. This is the constraint `include_str!` has always had.

## Load order

The order is defined and never depends on filesystem iteration. Nothing lists a directory.

1. The root file.
2. The root's parts, in the order of its `part` lines.
3. For each file loaded in steps 1 and 2, in that order, each of its `import` lines in order: the imported
   file (its root, then its parts, then its imports, by the same rules), unless it was already loaded.

Declarations are merged by appending in load order, so the root's own declarations come first and adding an
import never moves them. Mixins are expanded after the merge, so a model in one file can `@use` a mixin
from another.

## Splitting changes nothing

A split schema is the same schema. Its merged IR equals the IR of the same files concatenated in load
order (with each `part`, `part of` and `import` line removed), ignoring source positions. Consequently:

- generated Rust, Dart, TypeScript and WireMock output is unchanged: no generator reads a source position;
- `SCHEMA_SHA256` is unchanged, because it is a digest of the canonical IR, not of the text;
- `cratestack migrate diff` against a committed snapshot produces nothing after a split. See
  [Migrations](../guides/migrations#splitting-a-schema-changes-no-migration).

To see it yourself, print the IR of the split root and of a hand-made concatenation without source
positions, and diff them:

```bash
cratestack print-ir --schema schema.cstack --no-spans > split.txt
cratestack print-ir --schema concatenated.cstack --no-spans > joined.txt
diff split.txt joined.txt   # no output
```

## Rebuilds

`SCHEMA_SOURCE` keeps its type and meaning: it is the **root file's** text. A schema that spans more than
one file additionally gets `SCHEMA_FILES: &[(&str, &str)]`, a `(path, contents)` pair per file in load
order, root first, each path relative to `CARGO_MANIFEST_DIR`. The macro takes every `include_str!` path from the canonical path it actually read, so absolute macro literals and symlinked roots work. Its `include_str!`s are what register every
part and import, transitively, as rebuild dependencies of your crate. A single-file schema does not get
`SCHEMA_FILES`, so its generated output is byte-identical to before.

Editing any listed file rebuilds. Adding a part works because listing it is an edit to the root, which is
tracked; the macro re-expands and reads the new file. The one gap is stated, not hidden: a file that
declares `part of` but that **no root lists** is not read by any build, so it is ignored. `cratestack check`
and the editor report it when that file is checked or opened (see [Tooling](#tooling)). If your new part's
models do not exist, the root does not list it.

## Errors you may see

Paths in messages are relative to the root file's directory and written with `/`, except where noted.
Placeholders such as `{part}` stand for the real path or name. When an error involves two files, it also carries a related
location: `check --format json` adds a `related` array (see [Tooling](#tooling)) and editors show it as
related information.

| Message | Cause and fix |
| --- | --- |
| `` `{part}` is listed as a part of `{root}`, but does not declare `part of`; add `part of "{back}"` to `{part}` `` | The root lists a file that has no `part of`. Add the line the message gives. |
| `` `{part}` is listed as a part of `{root}`, but declares itself a part of `{other}` `` | The part names a different root. Point `part of` at the root that lists it, or list the part from `{other}`. |
| `` `{part}` declares itself a part of `{root}`, but `{root}` does not list it; add `part "{rel}"` to `{root}` `` | A `part of` file that no root lists. Add the `part` line to the root. |
| `` `{file}` is a part of `{root}`, not a schema root; point the macro or command at `{root}` `` | A part was given where a root is required. Use the root. `{file}` is the part as you gave it and `{root}` is the root resolved against it, so both paths work as given. For `--schema examples/react-vite-swr/schema/task.cstack` the message names `examples/react-vite-swr/schema.cstack`. |
| `` `{kind}` belongs in the root schema (`{root}`), not in a part `` | `datasource`, `auth`, `transport` or `mcp` in a part. Move it to the root. |
| ``a part cannot list parts of its own; move `part "{path}"` to the root schema (`{root}`)`` | Parts are one level deep. List the file from the root. |
| ``duplicate `part of` (first declared on line {n})`` | Two `part of` lines in one file. Remove one. |
| `` `{path}` is already listed as a part on line {n} `` | The root lists one file twice. Remove one line. |
| `` `{root}` lists itself as a part `` | A root has a `part` line naming itself. Remove it. |
| `` cannot import `{file}`: it is a part of `{root}`, and a part is locked to its root; import a file that does not declare `part of` instead `` | An `import` names a part. Import a shared file that has no `part of`. |
| `` import cycle: `{a}` → `{b}` → … → `{a}` `` | Imports form a cycle, including a file importing itself. When the `import` line sits in a part, that step reads `` `{root}` (part `{part}`) ``. Break the cycle at the import line the error points to. |
| `` `{kind} {name}` cannot come from an import: `{file}` is imported by `{importer}`, and an imported file may declare only `type`, `enum` and `mixin`; use `part` to split one schema across files `` | A model, view, procedure, topic, query or extension in an imported file. (For `transport` and `mcp` the message starts with `` `{kind}` `` alone.) Move it into the importer, or into a `part`. |
| `` `{name}` is declared twice: `{kind_a} {name}` in `{file_a}` (line {la}) and `{kind_b} {name}` in `{file_b}` (line {lb}) `` | One name in two files. Rename one. A repeat inside a single file keeps its single-file message. |
| `` cannot read `{path}` (listed on line {n} of `{file}`): {io error} `` | A listed file is missing or unreadable. Fix the path or restore the file. |
| `` `{directive}` path `{path}` must be a relative path written with `/` and ending in `.cstack` `` | An empty path, an absolute path, a backslash, or a missing `.cstack` suffix (a bare `.cstack` with no file name is refused too). |
| ``expected a quoted path after `{directive}`, like `{directive} "models/post.cstack"` `` | A directive with no quoted path, an unterminated quote, or text after the closing quote. |
| `` `{file}` changed while it was being loaded; load it again `` | A file was modified between two reads of the same load (rare race). Run the command or build again. |
| `` `{directive}` needs the schema to be loaded from a file, because "{path}" is resolved against that file's directory; use `parse_schema_file` or `cratestack check --schema <root>` `` | A directive given to a text-only parser entry point (`parse_schema`, `parse_schema_named` and similar). Load from a file. |

An unreadable **root** keeps its single-file message, `failed to read schema file {path}: {error}`.

The structural checks above, and every file's syntax, stop at the first error. After that, validation runs on
the merged schema and reports every independent error in one run, including errors from several files.
Splitting never turns a valid schema invalid: the loader refuses no pair of declarations that one
concatenated file would accept.

## Tooling

### The CLI

Every command that takes `--schema` (`check`, `print-ir`, `generate-dart`, `generate-typescript`,
`generate-wiremock`, `migrate diff`, `migrate baseline`, `diff`, `contract`) resolves the whole file graph.
They take the **root**; given a part they fail with the "is a part of … not a schema root" error. `check`
is the exception: given a part, it follows `part of` to the root, checks the whole schema, and says so:

```text
$ cratestack check --schema schema/task.cstack
`schema/task.cstack` is a part of `schema.cstack`; checked the whole schema
schema OK: schema.cstack
```

If the root does not list the part, that is the "declares itself a part of … does not list it" error, with
exit status 1. In `--format json` the payload keeps `schema` as given and adds `"root"` only when it
differs.

`check --list-files` prints the resolved file set after `schema OK`: a `files (N):` line, then one
`  role  path` line per file in load order, the role being `root`, `part`, `import` or `import part`
(an imported root's part). For the `react-vite-swr` example:

```text
$ cratestack check --schema schema.cstack --list-files
schema OK: schema.cstack
files (4):
  root        schema.cstack
  part        schema/board.cstack
  part        schema/task.cstack
  part        schema/procedures.cstack
```

With `--format json` it adds `"files": [{ "path", "role" }]`. Without
the flag the output is unchanged. A diagnostic that involves a second file carries
`"related": [{ "file", "line", "start", "end", "message" }]`, only when there is one.
The related locations are labelled `` `{kind} {name}` is declared here first ``, `` `{part}` is listed here ``,
`` `{file}` declares `part of` here `` and `` `{file}` is imported here ``.

`print-ir --no-spans` prints the IR with every source position zeroed, the form two schemas are compared in
(see [Splitting changes nothing](#splitting-changes-nothing)).

### The editor

The language server follows the file graph. Diagnostics are attributed to the file they belong to, a part
opened on its own is checked through its root, and go-to-definition and completion cross files (completion offers models, mixins, types, procedures and fields of the whole graph, not enum names). Rename is
refused in a schema that spans more than one file, or in any file whose text has a `part`, `part of` or `import` line, and references are file-local. Closing a file without saving reverts the analysis to its disk text. All of it is described in
[Editor tooling](../tooling/editor-tooling#multi-file-schemas).

## Limits

These are deliberate, and each is additive to lift later:

- no `import … as ns`, `show` or `hide` (today a parse error, so it is free to add);
- no models, views or procedures through `import`;
- no cross-file rename or find-references in the editor (a shared import opened alone, with no directive in it and no analysed importer, can still be renamed);
- no package or registry imports (`import "@scope/pkg"`);
- a build cannot detect an unlisted `part of` file.

The [roadmap](../overview/roadmap#multi-file-schemas) records why each is deferred and what unblocks it.

## Read Next

1. [ADR 0023: Multi-file Schemas](../internals/multi-file-schemas-adr)
2. [Mixins](./mixins), which an `import` may supply
3. [Editor tooling](../tooling/editor-tooling)
