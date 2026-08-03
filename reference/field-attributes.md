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
| `@id`                | Marks the primary-key field. Required; exactly one per model.                                              |
| `@default(value)`    | Server-side default applied when the create input omits the field.                                         |
| `@default(cuid())`   | Macro-emitted CUID on create.                                                                              |
| `@default(auth().x)` | Pulls a value from the auth context. Supports nested paths (`auth().organization.id`).                     |
| `@default(dbgenerated())` | Defers to the database default — the column must declare `DEFAULT` in SQL.                            |

Auth-defaulted columns are limited to `String`/`Cuid`, `Int`, and
`Boolean` and act as **fallbacks**: they fill the field only when the
create input omits it. They are not enforcement.

## Relations

| Attribute                                    | Behaviour                                                                                        |
|-----------------------------------------------|---------------------------------------------------------------------------------------------------|
| `@relation(fields:[...], references:[...])`  | Declares a relation. Required on **both** sides — the owning (single-model) side and the `Model[]` inverse side. |
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
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
}
```

Only the **owning side** (the field typed as a single model, not
`Model[]`) produces a real foreign-key constraint. See [ADR 0004](../internals/schema-diff-adr)
for the generated DDL, the SQLite limitation, and the full
`onDelete`/`onUpdate` validation rules — in short, an action can only
be declared on the owning side, `SetNull` requires the local field to
be optional, and `SetDefault` requires it to declare `@default(...)`.

## Exposure controls

| Attribute       | Effect on input        | Effect on output                   | Effect on audit                |
|-----------------|------------------------|------------------------------------|--------------------------------|
| `@readonly`     | Excluded from Create + Update inputs | Visible in responses | Visible in `before`/`after`    |
| `@server_only`  | Excluded from Create + Update inputs | Stripped from responses | Omitted entirely from snapshots |
| `@pii`          | No effect              | No effect                          | Redacted as `"<redacted: pii>"` |
| `@sensitive`    | No effect              | No effect                          | Redacted as `"<redacted: sensitive>"` |

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

## Relations

| Attribute                          | Behaviour                                                                                          |
|-------------------------------------|-----------------------------------------------------------------------------------------------------|
| `@relation(fields:[...], references:[...])` | Declares the owning side of a relation. Emits a `FOREIGN KEY` constraint in generated migrations. |
| `onDelete: <action>`                | Referential action on delete. One of `Cascade`, `Restrict`, `SetNull`, `SetDefault`, `NoAction`. Optional inside `@relation(...)`; defaults to `NoAction`. |
| `onUpdate: <action>`                | Referential action on update. Same vocabulary and default as `onDelete`.                            |

```cstack
model Application {
  id       String @id
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade, onUpdate: Restrict)
}
```

`onDelete`/`onUpdate` can only be declared on the relation's owning side — the has-many (`List`-typed) side has no physical column to attach a constraint to, and `cratestack check` rejects the attempt. `SetNull` additionally requires the local field to be optional (`tenantId String?`); `SetDefault` requires it to declare `@default(...)`. See [Migrations](../guides/migrations#foreign-keys-referential-actions-and-composite-uniqueness) for the generated DDL and naming convention.

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
| `@length(min, max)`    | `String`, `Cuid`  | Inclusive length check.                                    |
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
