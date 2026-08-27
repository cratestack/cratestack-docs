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

## Optimistic locking

| Attribute   | Behaviour                                                                |
|-------------|--------------------------------------------------------------------------|
| `@version`  | Marks the optimistic-lock column. Required `Int`; one per model; not on the primary key. |

See [optimistic locking](../guides/optimistic-locking) for the full
contract.

The macro excludes `@version` from both Create and Update inputs. The
runtime seeds it to `0` on create and bumps it in the same statement as
every update or soft-delete.

## Model-level uniqueness and indexes

| Attribute            | Behaviour                                                                 |
|-----------------------|----------------------------------------------------------------------------|
| `@@unique([...])`     | Composite uniqueness across the listed fields. Emits a `CREATE UNIQUE INDEX` spanning all of them, in declaration order. |
| `@@index([...])`      | A non-unique index across the listed fields, in declaration order. At least one field. |

```cstack
model Application {
  id          String @id
  tenantId    String
  name        String
  environment String

  @@unique([tenantId, name, environment])
  @@index([tenantId])
}
```

Field-level `@unique` (a single-column shorthand) is unaffected by this. See
[Migrations](../guides/migrations#foreign-keys-referential-actions-and-composite-uniqueness)
for the emitted DDL, and [Upsert](../guides/upsert) for why a matching
unique index is required for `ON CONFLICT` targets.

### Keyword arguments

Both attributes accept keyword arguments after the field list. Every one
of them is **verbatim passthrough** — the value is never parsed or
validated by CrateStack, only carried through to the emitted DDL and left
for the database to accept or reject.

| Argument               | `@@unique` | `@@index` | Effect                                            |
|------------------------|:----------:|:---------:|---------------------------------------------------|
| `where: "<predicate>"` | yes        | yes       | Trailing `WHERE <predicate>` — a **partial** index |
| `using: "<method>"`    | no         | yes       | Index method, e.g. `gin`, `gist`                   |
| `opclass: "<opclass>"` | no         | yes       | Operator class for the indexed column              |

Passing an unsupported key is a compile error, as is declaring the same
key twice.

### Partial indexes

`where:` constrains the index to the rows matching a predicate:

```cstack
model Payment {
  id             String  @id
  idempotencyKey String?

  @@unique([idempotencyKey], where: "idempotency_key IS NOT NULL")
}
```

Note the predicate is written in **SQL**, against column names, not
schema field names — it is passed through untouched.

**`where:` is the one case where a single-field `@@unique` is legal.**
Without it, `@@unique([x])` is rejected with "use a field-level `@unique`
instead", because the shorthand exists and is simpler. With `where:` that
alternative disappears — a field-level `@unique` has nowhere to put a
keyword argument — so the floor drops from two fields to one. It never
drops to zero: `@@unique([], where: "...")` is still rejected, matching
`@@index`'s unconditional at-least-one-field rule.

The example above is the motivating shape: a genuinely optional column
that must be unique **only when present**, with the predicate keeping the
index off the rows where the column is `NULL`.

SQLite supports the same `WHERE` syntax (partial indexes since 3.8.0). The
divergence between backends is what a predicate may legally *reference*,
not the syntax.

<Note>
Partial indexes round-trip through `cratestack migrate` without churn.
Postgres normalizes a stored predicate — `idempotency_key IS NOT NULL`
reads back as `(idempotency_key IS NOT NULL)`, and literal comparisons
gain an explicit cast (`status = 'active'::text`) — so the diff engine
compares predicates through a type-aware normalization rather than by raw
string equality. Writing the predicate in a different but equivalent
spelling than Postgres would store may still produce one drop-and-recreate;
ambiguous cases deliberately fail toward recreating the index rather than
toward silently leaving a stale one in place.
</Note>

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
