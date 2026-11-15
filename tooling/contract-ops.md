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
| `2` | The schema could not be read. With `--json`, stdout is `{ "ok": false, "error": "…" }`, as `contract check` prints; the message carries no terminal colour codes. |

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

The field set is stable: later releases only add fields. Keys come out in exactly the order shown.

| Field | Meaning |
| --- | --- |
| `schema` | The schema file's name without its extension. |
| `transport` | `rest` or `rpc`. |
| `key` | The op's key, the same one `contract digest` prints: an RPC `op_id` (`procedure.ping`, `model.Widget.list`), or `"<METHOD> <route template>"` on REST. |
| `kind` | `procedure`, `subscription` (a `subscription procedure`), or `model.<verb>` (`list`, `get`, `create`, `update`, `delete`, `subscribe`). |
| `allow`, `deny` | The rule texts as written, in order. For a model op, the `@@allow` / `@@deny` rules of that verb (a rule for `all` applies to every verb). |
| `roles` | Every `hasRole("…")` literal **named** anywhere in an `allow` rule, sorted and deduplicated. A `deny` rule adds none. This is a **superset** of the roles that grant access, not the roles that grant it: a role under a branch that cannot hold, or in an `&&` that something else blocks, is still listed. |
| `requires_principal` | `true` when no `allow` rule can hold for a caller with no principal. See below. |
| `unanalysed` | Rule texts the analysis did not fully understand, and any attribute the macros' own audit would refuse (a mis-spaced `@allow (x)`, an invisible character). |
| `contract_digest` | The same per-op digest `contract digest` prints. |

Which rules decide which model verb is one table, `cratestack_policy::model_verb_policy_slot`, which the
macros generate from and this command reads, so the report cannot describe a different slot than the generated
code consults:

| Verb | Rules that decide it | Descriptor slot |
| --- | --- | --- |
| `list` | `"list"`, `"read"`, `"all"` | `read_allow_policies` / `read_deny_policies` |
| `get` | `"detail"`, `"read"`, `"all"` | `detail_allow_policies` / `detail_deny_policies` |
| `subscribe` | `"detail"`, `"read"`, `"all"` | `detail_allow_policies` / `detail_deny_policies` |
| `create` | `"create"`, `"all"` | `create_allow_policies` / `create_deny_policies` |
| `update` | `"update"`, `"all"` | `update_allow_policies` / `update_deny_policies` |
| `delete` | `"delete"`, `"all"` | `delete_allow_policies` / `delete_deny_policies` |

`subscribe` reads the **`detail`** slot, like `get`, not the `list` one: a feed decides each event the way `get`
decides one row, at open and for every event. A model with `@@allow("list", hasRole("a"))` and
`@@allow("detail", auth() == null)` therefore reports `list` as needing a principal and `get` and `subscribe`
as not.

## What `requires_principal` means

Every policy node evaluates, for a caller with no principal, to one of two things: **always false** (no row and no
input can make it hold) or **maybe true**. `requires_principal` is `true` exactly when every `@allow` rule is
always false, or when there is no `@allow` at all. It is never `true` for an op an anonymous caller can pass.

| Term | For a caller with no principal |
| --- | --- |
| `true`, `auth() == null` | maybe true |
| `auth() != null`, `hasRole("…")`, `inTenant("…")`, `auth().isSystem()`, `false` | always false |
| A comparison with an `auth()` side (`auth().<claim> == …`, `column == auth().<claim>`, `auth() == <relation>`) | always false, unless a `none` or `every` quantifier wraps it (below) |
| A comparison of inputs or fields, an `in [...]` list, a bare boolean field | maybe true |
| Anything the analysis does not understand | maybe true, and listed in `unanalysed` |

A string literal is a value, never an operator: `label in ["== auth().id", "public"]` is a set-membership
test (maybe true), not a comparison with `auth()`, and `x != "a == b"` is one `!=`. The analysis and the
macros read a term with the same code, which looks for set membership before a comparison and ignores `==`,
`!=`, `&&`, `||` and parentheses inside `"…"` or `'…'` (a backslash escapes a quote). A literal such as
`@allow(x == "a||b")` therefore compiles, where it used to be rejected as two malformed terms.

Rules combine like this: `&&` is always false if **any** branch is, `||` only if **every** branch is, and several
`@allow` lines are alternatives. `@deny` is not consulted: it can only refuse, so it cannot make an op callable.

### Relation quantifiers

For an anonymous caller a comparison with `auth()` renders `FALSE`, and what a relation quantifier makes of that
decides the whole term (`memberships.<quantifier>.userId == auth().id`):

| Quantifier | Rendered | Anonymous |
| --- | --- | --- |
| `some`, or a to-one hop (`owner.id == auth().id`) | `EXISTS (… AND FALSE)` | always false |
| `none` | `NOT EXISTS (… AND FALSE)`, true for every row | maybe true |
| `every` | `NOT EXISTS (… AND NOT (FALSE))`, vacuously true for a row with no related rows | maybe true |

A `none` or `every` anywhere in the path (`a.some.b.none.c == auth().id`) makes the term maybe true. So
`@@allow("read", memberships.none.userId == auth().id)` reports `requires_principal: false`, and so does the
`every` form.

**An op with no `@allow`** is denied to every caller (deny by default). It reports
`requires_principal: true` with an empty `allow`, so a consumer that wants "ops callable anonymously" does not
list it, and one that wants "ops naming role X" does not either. Check for an empty `allow` to tell it
apart from a real principal requirement.

**A rule the analysis does not understand** (a malformed expression, an unknown function, an unrecognised
term shape, an attribute the macros' audit would refuse) is listed in `unanalysed`, and the op reports
`requires_principal: false`, treated as anonymous. A consumer that gates on this must refuse any op with a
non-empty `unanalysed` rather than trust the verdict.

## Deriving an allowlist and checking it is complete

`roles` lists the roles an op **names**, so it over-approximates who may call it. An allowlist recipe must treat
it as a superset, must also read `requires_principal`, and must refuse any op with a non-empty `unanalysed`:

```bash
cratestack contract ops --schema s.cstack --json > ops.json
# Refuse the whole derivation if any op has a rule the analysis could not read.
jq -e '[.ops[] | select(.unanalysed | length > 0)] | length == 0' ops.json >/dev/null \
  || { echo "ops with unanalysed rules; refusing to derive" >&2; exit 1; }
# Candidates: ops that name the role AND are not callable anonymously. Review the
# list: naming a role does not mean the role is what grants access.
jq -r '.ops[] | select((.roles | index("operator")) and .requires_principal) | .key' ops.json \
  | sort > derived.txt
diff <(sort operator-allowlist.txt) derived.txt
```

An op that names the role but reports `requires_principal: false` is callable with no principal at all; it must
not sit on an allowlist that assumes authentication, so list those separately rather than dropping them:

```bash
jq -r '.ops[] | select((.roles | index("operator")) and (.requires_principal | not)) | .key' ops.json
```
