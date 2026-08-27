---
title: Field Attributes
description: Reference for `.cstack` field attributes, including the banking-readiness additions.
---

# Field Attributes

This reference covers every supported field-level attribute. Model-level
(`@@`) attributes live in their dedicated guides — see
[audit log](../guides/audit-log) for `@@audit`,
[soft delete](../guides/soft-delete) for `@@soft_delete`,
[pagination](../guides/pagination) for `@@paged`,
[auth support matrix](./auth-support-matrix) for `@@allow` / `@@deny`, and
[composite keys](./composite-keys) for `@@id([...])` / `@@unique([...])`.
Two model-level attributes are documented here because they have no
dedicated guide: `@@internal(...)` (below) and `@@unique([...])`'s
emitted DDL.

## Identity & Defaults

| Attribute            | Behaviour                                                                                                  |
|----------------------|------------------------------------------------------------------------------------------------------------|
| `@id`                | Marks the primary-key field. At least one required per model (or a model-level `@@id([...])`).             |
| `@default(value)`    | Server-side default applied when the create input omits the field.                                         |
| `@default(auth().x)` | Pulls a value from the auth context. Supports nested paths (`auth().organization.id`).                     |
| `@default(dbgenerated())` | Defers to the database default — the column must declare `DEFAULT` in SQL. This is how `Cuid` primary keys are generated in practice, e.g. `id Cuid @id @default(dbgenerated())`. |

Auth-defaulted columns are limited to `String`/`Cuid`, `Int`, and
`Boolean` and act as **fallbacks**: they fill the field only when the
create input omits it. They are not enforcement.

**"Exactly one `@id`" is not actually enforced for field-level `@id`.**
The parser only checks that a model has *at least one* — nothing rejects
two (or more) fields each carrying a bare `@id`. That's a different gap
from `@@id([...])`, which the parser and `cratestack-macros` do reject
outright (see [composite keys](./composite-keys)): two field-level `@id`
attributes silently bypass that guard, because it only looks for the
`@@id(` model-level attribute, not a duplicate field-level one.
`cratestack-migrate` then marks every `@id`-tagged column
`primary_key = true` and joins all of them into one multi-column
`PRIMARY KEY` constraint — an accidental composite key with none of the
authoring safeguards `@@id([...])` gets. Stick to exactly one `@id`
field per model; don't rely on the parser to catch a second one for you.
Tracked as [issue #536](https://github.com/cratestack/cratestack/issues/536).

## Relations

| Attribute                                    | Behaviour                                                                                        |
|-----------------------------------------------|---------------------------------------------------------------------------------------------------|
| `@relation(fields:[...], references:[...])`  | Declares a relation. Required on **both** sides — the owning (single-model) side and the `Model[]` inverse side. Only the owning side emits a real `FOREIGN KEY` constraint in generated migrations. |
| `@relation(..., onDelete: <Action>)`         | Referential action on delete. Optional; defaults to `NoAction`.                                   |
| `@relation(..., onUpdate: <Action>)`         | Referential action on update. Optional; defaults to `NoAction`.                                   |

`<Action>` is one of `Cascade`, `Restrict`, `SetNull`, `SetDefault`, `NoAction` — bareword identifiers, not string literals.

```cstack
model Tenant {
  id String @id
}

model Application {
  id       String @id
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade, onUpdate: Restrict)
}
```

`onDelete`/`onUpdate` can only be declared on the relation's **owning
side** (the field typed as a single model, not `Model[]`) — the has-many
(`List`-typed) side has no physical column to attach a constraint to, and
`cratestack check` rejects the attempt. `SetNull` additionally requires
the local field to be optional (`tenantId String?`); `SetDefault`
requires it to declare `@default(...)`.

See [ADR 0004](../internals/schema-diff-adr) for the generated DDL and
the SQLite limitation, and [Migrations](../guides/migrations#foreign-keys-referential-actions-and-composite-uniqueness)
for the generated DDL and naming convention.

## Exposure controls

| Attribute       | Effect on input        | Effect on output                   | Effect on audit                |
|-----------------|------------------------|------------------------------------|--------------------------------|
| `@readonly`     | Excluded from Create + Update inputs | Visible in responses | Visible in `before`/`after`    |
| `@server_only`  | Excluded from Create + Update inputs | Stripped from responses | Omitted entirely from snapshots |
| `@pii`          | No effect              | No effect                          | Redacted as `"[redacted-pii]"` |
| `@sensitive`    | No effect              | No effect                          | Redacted as `"[redacted-sensitive]"` |

Use `@readonly` for columns the server writes but clients may read (audit
timestamps, computed totals). Use `@server_only` for columns clients
should never see (internal risk scores, raw token blobs). Use `@pii` or
`@sensitive` to control audit redaction without changing input/output
surfaces.

## Route suppression

`@@internal("action")` is a model-level declaration that an action must
never be reachable from the wire: no REST route, no RPC dispatch arm,
and no client stub in any generated SDK, on either transport.

```cstack
model Widget {
  id   String @id
  name String

  @@allow("create", auth().isSystem())
  @@internal("create")
}
```

It accepts one action per declaration, from the same vocabulary
`@@allow` / `@@deny` use — so there is no second action vocabulary to
learn:

| Action     | Wire verbs suppressed                     |
|------------|-------------------------------------------|
| `"list"`   | `list`                                    |
| `"detail"` | `get`                                     |
| `"read"`   | `list`, `get`                             |
| `"create"` | `create`                                  |
| `"update"` | `update`                                  |
| `"delete"` | `delete`                                  |
| `"all"`    | `list`, `get`, `create`, `update`, `delete` |

**Exactly one action per declaration.** `@@internal("create", "update")`
is a compile error. Suppressing more than one action means writing more
than one `@@internal("action")` line — the same repeated-declaration
shape `@@allow` / `@@deny` already use. An action name outside the table
above is also a compile error, naming the model and the bad action.

### What suppression actually does

Suppression is implemented as *emitting nothing*, so the observable
behaviour is whatever axum does with a route that was never registered:

* A suppressed verb on a path that still has surviving verbs gets axum's
  own **`405 Method Not Allowed`**.
* A model that suppresses every verb on a path never registers that path
  at all — axum's own **`404`**.
* A suppressed RPC op id falls into the pre-existing unknown-op-id arm
  and returns the same `NotFound` a genuinely unknown op id gets,
  including per-frame inside `POST /rpc/batch` (a suppressed op in one
  frame does not poison sibling frames).

The canonical case this unblocks is a model whose policy is fail-closed
and correct but whose route could only ever `403` — `@@allow("create",
auth().isSystem())` still generated a `POST` route and a `.create()`
client method. `@@internal("create")` removes both.

### Scope and limits

* **Generation-time only.** Policy evaluation is untouched: a suppressed
  action's `@@allow` / `@@deny` rules still compile and still gate
  in-process callers, so a custom procedure calling `db.create()`
  directly is still policy-checked exactly as before.
* **Client input types follow.** `Create<Model>Input` /
  `Update<Model>Input` are omitted from generated **client** SDKs when
  the corresponding verb is suppressed. The server's own ORM-facing
  input types are unaffected.
* **Mock stubs follow.** [`generate-wiremock`](../tooling/generate-wiremock)
  omits mappings for suppressed actions, so a mock never advertises a
  contract the real server doesn't honour.
* **Breaking, opt-in per action.** Adding `@@internal` to an action a
  generated client already calls removes that client method — a compile
  error at the call site on regeneration rather than a runtime `403`
  discovered later. [`cratestack diff`](../tooling/schema-diff)
  classifies that as Breaking. A model with no `@@internal` attribute
  generates byte-identical output to before the feature existed.

## Optimistic locking

| Attribute   | Behaviour                                                                |
|-------------|--------------------------------------------------------------------------|
| `@version`  | Marks the optimistic-lock column. Required `Int`; one per model; not on the primary key. |

See [optimistic locking](../guides/optimistic-locking) for the full
contract.

The macro excludes `@version` from both Create and Update inputs. The
runtime seeds it to `0` on create and bumps it in the same statement as
every update or soft-delete.

## Model-level uniqueness

| Attribute            | Behaviour                                                                 |
|-----------------------|----------------------------------------------------------------------------|
| `@@unique([...])`     | Composite uniqueness across the listed fields. Emits a `CREATE UNIQUE INDEX` spanning all of them, in declaration order. |

```cstack
model Application {
  id          String @id
  tenantId    String
  name        String
  environment String

  @@unique([tenantId, name, environment])
}
```

Field-level `@unique` (a single-column shorthand) is unaffected by this — `@@unique` is for composite constraints that span more than one field. See [Migrations](../guides/migrations#foreign-keys-referential-actions-and-composite-uniqueness) for the emitted DDL, and [Upsert](../guides/upsert) for why a matching unique index is required for `ON CONFLICT` targets.

## Validators

| Attribute              | Applies to        | Behaviour                                                  |
|------------------------|-------------------|------------------------------------------------------------|
| `@length(min, max)`    | `String`, `Bytes` | Inclusive length check.                                    |
| `@range(min, max)`     | `Int`, `Decimal`  | Inclusive numeric range. Integer bounds promote to Decimal. |
| `@email`               | `String`          | Pragmatic email shape check.                               |
| `@regex(pattern)`      | `String`          | Pattern compiled at macro time.                            |
| `@uri`                 | `String`          | Must parse as a URI.                                       |
| `@iso4217`             | `String`          | Three ASCII uppercase letters.                             |

See [validators](../guides/validators) for the full surface, including
the PII-safe error message contract.

## Type modifiers

| Suffix | Meaning              | Example                  |
|--------|----------------------|--------------------------|
| `?`    | Nullable / optional  | `notes String?`          |
| `[]`   | List                 | `tags String[]`          |

Lists are supported only for a subset of scalars in the current slice;
banks running JSON columns prefer `@db.JsonB` on a `String` for richer
payloads.

## Composition

Multiple attributes on one field are space-separated and additive:

```cstack
model Transfer {
  id Int @id
  amount Decimal @range(min: 0)
  notes String? @sensitive @length(max: 4000)
  reservationId String @server_only
  version Int @version
}
```

The macro applies them in this evaluation order:

1. exclusion from inputs (`@id`, `@readonly`, `@server_only`, `@version`, `@default(...)`)
2. validation on whatever survives (`@length`, `@range`, `@regex`, `@email`, `@uri`, `@iso4217`)
3. policy evaluation (model-level `@@allow` / `@@deny`)
4. SQL execution
5. response projection (server_only stripped here)
6. audit snapshot (pii / sensitive redacted here)
