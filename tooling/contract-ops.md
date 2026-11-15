---
title: Listing ops, roles and principal requirements
description: "cratestack contract ops lists every op a schema exposes with the roles its @allow rules name and whether it can be called with no principal, from the compiler's own policy analysis."
---

# Listing Ops, Roles And Principal Requirements

*(unreleased on main, [cratestack#1388](https://github.com/cratestack/cratestack/issues/1388))*

`cratestack contract ops` is a read-only report of every op a schema exposes, with the rules written on
it, the roles those rules name, and whether the op can be called with no principal. It exists for
consumers that gate their own artefacts on a schema's policies: a relay that keeps one allowlist per
client app, an API gateway's route table. Those used to port the policy grammar by hand, which drifts
with every release. This command answers from the parser the macros lower `@allow` from, so there is
one source of truth.

```bash
cratestack contract ops --schema path/to/schema.cstack          # a table
cratestack contract ops --schema path/to/schema.cstack --json   # one JSON document
```

| Exit code | Meaning |
| --- | --- |
| `0` | The report printed. |
| `2` | The schema could not be read. With `--json`, stdout is `{ "ok": false, "error": "…" }`, as `contract check` prints. |

## The JSON document

```json
{
  "ok": true,
  "schema": "admin-actions",
  "transport": "rpc",
  "ops": [
    {
      "key": "procedure.listActionsAwaitingSignature",
      "kind": "procedure",
      "allow": ["hasRole(\"admin\")"],
      "deny": [],
      "roles": ["admin"],
      "requires_principal": true,
      "unanalysed": [],
      "contract_digest": "…"
    }
  ]
}
```

The field set is stable: later releases only add fields.

| Field | Meaning |
| --- | --- |
| `schema` | The schema file's name without its extension. |
| `transport` | `rest` or `rpc`. |
| `key` | The op's key, the same one `contract digest` prints: an RPC `op_id` (`procedure.ping`, `model.Widget.list`), or `"<METHOD> <route template>"` on REST. |
| `kind` | `procedure`, `subscription` (a `subscription procedure`), or `model.<verb>` (`list`, `get`, `create`, `update`, `delete`, `subscribe`). |
| `allow`, `deny` | The rule texts as written, in order. For a model op, the `@@allow` / `@@deny` rules of that verb (a rule for `all` applies to every verb). |
| `roles` | Every `hasRole("…")` literal reachable in an `allow` rule, sorted and deduplicated. A `deny` rule adds none. |
| `requires_principal` | `true` when no `allow` rule can hold for a caller with no principal. See below. |
| `unanalysed` | Rule texts the analysis did not fully understand. |
| `contract_digest` | The same per-op digest `contract digest` prints. |

Which rules decide which model verb: `list` and `subscribe` read `@@allow("list", …)`, `@@allow("read", …)`
and `@@allow("all", …)`; `get` reads `"detail"`, `"read"` and `"all"`; `create`, `update` and `delete` read their
own name and `"all"`.

## What `requires_principal` means

It is `true` when every `@allow` rule needs a caller with a principal. Rules combine the way the server
evaluates them: `||` needs a principal only when every branch does, `&&` when any branch does, and several
`@allow` lines are alternatives.

| Term | Needs a principal |
| --- | --- |
| `auth() != null`, `hasRole("…")`, `inTenant("…")`, `auth().isSystem()` | yes |
| A comparison against an `auth().<claim>` on either side | yes (an absent claim satisfies neither `==` nor `!=`) |
| `true`, `auth() == null` | no |
| A comparison of inputs or fields, an `in [...]` list, a bare boolean field | no |
| `false` | yes (it never holds) |

`@deny` is not consulted: it can only refuse, so it cannot make an op callable.

**An op with no `@allow`** is denied to every caller (deny by default). It reports
`requires_principal: true` with an empty `allow`, so a consumer that wants "ops callable anonymously" does not
list it, and one that wants "ops naming role X" does not either. Check for an empty `allow` to tell it
apart from a real principal requirement.

**A rule the analysis does not understand** (a malformed expression, an unknown function, an unrecognised
term shape) is listed in `unanalysed`, and the op reports `requires_principal: false`, treated as anonymous.
A consumer that gates on this should refuse any op with a non-empty `unanalysed` rather than trust the
verdict.

## Deriving an allowlist and checking it is complete

Because the list is complete, a consumer can compute "every op naming role X" and compare it with its
committed list, instead of only checking that each listed row is valid:

```bash
cratestack contract ops --schema s.cstack --json \
  | jq -r '.ops[] | select(.roles | index("operator")) | .key' | sort > derived.txt
diff <(sort operator-allowlist.txt) derived.txt
```
