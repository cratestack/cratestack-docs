---
title: Schema diff
description: Detect wire-breaking changes between two .cstack schemas before they ship — usable as a CI gate on schema PRs.
---

# Schema Diff

`cratestack diff old.cstack new.cstack` structurally compares two schema versions and classifies
every change by its effect on the generated wire contract — REST/RPC responses and client-constructed
payloads — rather than by raw text differences.

It exists because that effect is easy to miss by eye. Adding `@@paged` to a model, for example, looks
like a one-line change in the schema but silently turns every generated client's `Model.list()` return
type from `Model[]` into `Page<Model>` — a breaking change for every existing consumer, only visible
today by diffing generated TypeScript/Dart output before and after.

## Usage

```bash
cratestack diff old.cstack new.cstack
```

```text
schema diff: old.cstack -> new.cstack

BREAKING (1):
  - model `Transaction` gained `@@paged` — `Transaction.list()`'s response envelope changes from `Transaction[]` to `Page<Transaction>`

1 change(s): 1 breaking, 0 additive, 0 internal-only
```

The process exits non-zero whenever at least one breaking change is present, so the same invocation
works as a CI gate on schema pull requests. `diff` takes two file paths, not git refs, so pull the base
branch's copy of the schema out to a temp file first:

```yaml
# .github/workflows/schema-diff.yml
name: schema-diff
on: pull_request

jobs:
  breaking-change-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: dtolnay/rust-toolchain@stable
      - run: git show origin/${{ github.base_ref }}:schema.cstack > /tmp/old.cstack
      - run: cargo run -p cratestack-cli -- diff /tmp/old.cstack schema.cstack
```

A failing step here means the PR introduces a breaking wire-contract change — reviewers see it
before generation ever runs, in both languages.

Add `--json` for machine-readable output:

```bash
cratestack diff old.cstack new.cstack --json
```

```json
{
  "changes": [
    {
      "severity": "breaking",
      "category": "model_attribute_paged",
      "subject": "model `Transaction`",
      "message": "model `Transaction` gained `@@paged` — `Transaction.list()`'s response envelope changes from `Transaction[]` to `Page<Transaction>`"
    }
  ],
  "summary": { "breaking": 1, "additive": 0, "internal": 0 }
}
```

## Classification

Models, fields, and procedures are matched **by name only** — the same rename-agnostic philosophy
`cratestack migrate diff` uses for DB schema diffing. A rename shows up as a removal plus an addition,
not as a rename; there is no heuristic rename detection to avoid false positives.

Each change lands in one of three buckets:

| Severity | Meaning |
| --- | --- |
| **Breaking** | Changes the wire contract in a way existing consumers can't tolerate. Fails the CI gate. |
| **Additive** | Extends the wire contract without disturbing existing consumers. |
| **Internal-only** | Recognised change with no tracked wire-shape effect (yet — see [Known gaps](#known-gaps)). |

### Breaking

* Removing a model, field, or procedure.
* Adding `@@paged` to a model, or removing it — flips `.list()`'s response envelope between `T[]` and
  `Page<T>`.
* Adding a **required** field or procedure argument with no default — existing client payloads that
  omit it are rejected.
* Retyping a field, argument, or return type.
* Narrowing arity: optional → required, or introducing/removing a list (`[]`).
* A procedure changing kind (`query` ↔ `mutation`) — the generated dispatch/HTTP method differs.

### Additive

* Adding a model, an optional field, or a procedure.
* Adding a required field/argument that carries a `@default(...)` — the server fills it in, so existing
  payloads still work.
* Widening arity: required → optional.

### Internal-only

* Model-level attributes other than `@@paged` — `@@soft_delete`, `@@audit`, `@@retain(...)`,
  `@@emit(...)`. These affect server-side behavior (e.g. which rows a query returns) but not the shape
  of the response the client sees.

## Known gaps

This is a first pass scoped to the most common, clear-cut categories — not an exhaustive breaking-change
taxonomy. Explicitly out of scope for now:

* **Behavioral (non-shape) breaking changes.** `@@soft_delete` changes which rows `.list()`/`.get()`
  return; that's a real behavior change for callers, but it doesn't change the response *type*, so it's
  reported as internal-only today.
* **Views, mixins (as declarations), and enums are not diffed directly.** Mixin fields are already
  inlined into `Model.fields` by the parser before this tool sees them, so a mixin field change is
  caught as a field change on every model that uses the mixin — but the mixin declaration itself, and
  view/enum definitions, aren't compared.
* **Policy (`@@allow`/`@@deny`) changes** are not diffed — a policy that goes from permissive to
  restrictive is an authorization-breaking change this tool doesn't yet see.
* **Field-level attribute changes** other than what feeds the type/arity/default checks above (e.g.
  `@pii`, `@sensitive`, `@unique`) aren't classified.

Source of truth: [issue #134](https://github.com/cratestack/cratestack/issues/134).

## Read Next

1. [Migrations](../guides/migrations) — the DB-facing counterpart: `cratestack migrate diff` diffs
   `.cstack` against a committed snapshot to generate SQL, using the same by-name matching philosophy.
2. [Installing the CLI](./cli-install) — get `cratestack` on your machine.
