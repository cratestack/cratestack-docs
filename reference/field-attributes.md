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

**Exactly one field-level `@id` per model.** A second one is refused
("model `…` declares more than one field-level `@id`"), so an accidental
composite key can't slip through; use [`@@id([...])`](./composite-keys) when
you mean one. It used to be accepted and silently joined into one multi-column
`PRIMARY KEY` ([issue #536](https://github.com/cratestack/cratestack/issues/536)).

**`@id` is matched exactly** *(since 0.14.0,
[cratestack#1074](https://github.com/cratestack/cratestack/issues/1074))*. Only
a bare `@id` makes a field the primary key. `@identity`, `@idx` and `@id_foo`
are not keys: a model keyed only by one of them reports a missing `@id`, and
`@idx` gets a "did you mean `@id`?" error. `@id(...)` is refused ("`@id` takes
no arguments — write `@id`"). Before 0.14.0 any attribute starting with `@id`
counted as the key everywhere except `cratestack-migrate`, so the two could
disagree.

## Relations

| Attribute                                    | Behaviour                                                                                        |
|-----------------------------------------------|---------------------------------------------------------------------------------------------------|
| `@relation(fields:[...], references:[...])`  | Declares a relation. Required on **both** sides — the owning (single-model) side and the `Model[]` inverse side. Only the owning side emits a real `FOREIGN KEY` constraint in generated migrations. At most one `@relation` per field *(since 0.14.0)*; a second is refused. |
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
| `@server_only`  | Excluded from Create + Update inputs; ignored in procedure arguments; refused as a filter or sort key (since 0.13.0) | Stripped from responses, procedure outputs included (since 0.13.0) | Omitted entirely from snapshots |
| `@pii`          | No effect              | No effect                          | Redacted as `"[redacted-pii]"` |
| `@sensitive`    | No effect              | No effect                          | Redacted as `"[redacted-sensitive]"` |

Use `@readonly` for columns the server writes but clients may read (audit
timestamps, computed totals). Use `@server_only` for columns clients
should never see (internal risk scores, raw token blobs). `@server_only`
applies only to a stored scalar column of a model; see
[where it is refused](#where-server-only-is-refused) (unreleased). Use `@pii` or
`@sensitive` to control audit redaction without changing input/output
surfaces.

A procedure argument can name a model directly (`procedure p(account: Account)`)
or through a `type` that embeds one. A `@server_only` field in that argument is
never read from the request: the implementation always sees the field's default,
whatever the client sent, on both transports. Before 0.13.0 (cratestack#1051)
the field was only skipped on output, so a client could set it this way. If a
procedure took a `@server_only` value from its argument, treat that value as
client-controlled and derive it on the server instead.

Since 0.13.0 ([GHSA-ch54-jqw2-vpp5](https://github.com/cratestack/cratestack/security/advisories/GHSA-ch54-jqw2-vpp5)),
two more paths hold:

1. **A procedure output never carries the field.** A procedure whose output is, or contains, a
   model with a `@computed` field used to send that model's `@server_only` fields, over REST and
   RPC (`/rpc/batch` included), from v0.8.11 through v0.12.0. The output was composed field by
   field, so the serde skip never ran. This covered the model itself, `T?`, `T[]`, `Page<T>`, and
   a `type` that embeds the model. Model get and list responses, `?fields=`, `?include=`, MCP
   resources and `@@subscribe` events never sent it.
2. **A request cannot filter or sort by the field.** From v0.2.0 through v0.12.0 any caller who
   could list a model could test a `@server_only` value (`?secret=HUNTER2`), rebuild it one
   character at a time (`?secret__startsWith=H`), or order rows by it (`?sort=secret`), through
   every operator, the `where=` and `or=` grammars, relation paths (`?owner.secret=`,
   `?pets.some.token=`, `?sort=owner.secret`), RPC `model.<Model>.list`, and a `FindMany<Model>`
   procedure argument. Such a key is now refused exactly like a field the model does not declare,
   so the refusal does not reveal that the field exists: `400 unsupported query filter`,
   `422 unsupported sort field`, a `FindMany` `where` key that is ignored, and a `FindMany` sort
   field that does not decode. `includeFields[<relation>]` naming a `@server_only` field is
   refused too, as `?fields=` already was.

The generated `<Model>Where` and `<Model>SortField` have no member for a `@server_only` field, in
Rust (server and client role) and in the Dart client; the TypeScript client never had one. Server
code that needs to filter or sort by the field, such as a lookup by a hashed token, keeps the typed
builders, which read no request: `<model>::<field>().eq(..)` and
`.order_by(<model>::<field>().asc())`.

If you ran an affected version, treat as disclosed every `@server_only` value reachable through
either path, and rotate credentials, tokens and hashes stored in such fields. The generated Dart
model class declares and decodes `@server_only` fields, so a value an affected server sent may also
sit in client-side state or logs. A response
`IdempotencyLayer` stored before the upgrade is replayed as stored until its record expires; clear
the idempotency store or wait out its TTL. The advisory has the full guidance.

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

## Spelling and placement

<Warning>
**Unreleased.** The rules in this section are on `main` and in no published release yet (framework
[CHANGELOG](https://github.com/cratestack/cratestack/blob/main/CHANGELOG.md), `## Unreleased`:
"Security: policy attributes the generator skipped are refused (GHSA-69g4-xvcm-vm2j)" and
"`@server_only` is refused where it has no effect, and attributes in spellings no generator reads").
Both are breaking. Through 0.14.0 most spellings refused below pass `cratestack check` with
`schema OK` and have **no effect**.
</Warning>

Generators recognise most attributes by their exact text, so an attribute written any other way
used to be skipped silently. A schema is now refused, with an error that names the attribute,
when it relies on such a spelling.

### Trailing comments

A trailing `// comment` on a field line or a `@@` line is a comment, and is dropped before
anything reads the attribute. `//` inside a string literal (`"http://…"`, SQL in `"…"` or
`"""…"""`) is not a comment. Two consequences, neither of which raises an error:

1. **An attribute named inside a comment no longer applies.** Through 0.14.0,
   `secret String // was @server_only` kept `secret` off the wire; from this change it is an
   ordinary field, returned to clients. The same holds for `@readonly` (the field becomes
   writable), `@pii` / `@sensitive` (no longer redacted in the audit log), `@id` and every other
   field attribute. Write the attribute outside the comment before upgrading if the field relied
   on it.
2. **An attribute followed by a comment now takes effect.** `@@audit // …` starts writing audit
   rows, `@@soft_delete // …` makes deletes soft, and `@@allow(…) // …` grants what it says,
   where through 0.14.0 each was skipped. Confirm each such `@@allow` grants what you intend.

### Attributes that take no arguments

`@server_only`, `@readonly`, `@version`, `@pii`, `@sensitive`, `@db_enforce`, `@email`, `@uri`,
`@iso4217` and `@unique` are written bare (`@id(...)` is refused since 0.14.0). An argument list or stray punctuation
(`@readonly()`, `@server_only(true)`, `@version()`, `@readonly,`) is refused: through 0.14.0,
`@readonly()` left the field settable through the generated create input and `@version()` left
the model without a version field. Two attributes need a space between them:
`@server_only@unique` is refused. An `@` inside a string argument (`@default("a@b.c")`) is not
affected. A longer name such as `@unique_per_tenant` is a different attribute.

### Where server-only is refused

`@server_only` keeps a stored scalar column of a model out of every generated input and output.
It is a schema error in the five positions where it did nothing:

| Position | What to do instead |
| --- | --- |
| a field of a `type` block | leave the value out of the type |
| a relation field (to-one or to-many) | mark the related model's individual fields |
| a relation key: a scalar in an `@relation`'s `fields: [...]`, or in the `references: [...]` of a relation that targets its model (both ends, self-relations and mixin fields included) | replace it with `@readonly`, which keeps the key out of the create and update inputs as `@server_only` did; removing it outright makes the key settable by clients |
| a `@version` field | none: clients need the version for conditional writes |
| a field of the `auth` block | none: no generator reads attributes there |

### Block attributes are a closed list

Only models and views take `@@` attributes, each from its own list, spelled exactly, with an
argument list exactly when the name takes one and nothing after the closing `)`:

- **model:** `@@allow`, `@@deny`, `@@emit`, `@@paged`, `@@audit`, `@@soft_delete`, `@@retain`,
  `@@subscribe`, `@@id`, `@@unique`, `@@index`, `@@internal`, `@@rename` (and `@@mcp`)
- **view:** see [Views](./views#parse-time-validation-summary)

Any other `@@` name is refused, with a suggestion when one is close: a typo, a Prisma habit such
as `@@map(…)`, `@@check(…)` (never implemented), or a view-only attribute on a model. So are
whitespace before `(`, an empty argument list, and two block attributes on one line
(`@@audit @@soft_delete`). The `@@allow` / `@@deny` spelling rules are in the
[auth support matrix](./auth-support-matrix#policy-attribute-spelling).

### Rename markers

`@@rename` on a model takes exactly `@@rename(from = "<old_table>")`, and a field's `@rename`
exactly `@rename(from = "<old_column>")`: the only forms `cratestack migrate` reads. Through
0.14.0 any other form (`@@rename(from: "documents")`, `@rename(from: "name")`) passed `cratestack check`
and was read as no marker, so the next migration **dropped** the old table or column and created
a new one instead of renaming it. Other forms are now refused, and so are a second marker on the
same model or field and a `@rename` on a field of a `view`, `type` or `auth` block or on a
relation field, where the migrator never read it. If you ran `migrate diff` with a refused
marker, check the generated migrations for a `DROP TABLE` or `DROP COLUMN` of the old name. See
[Migrations](../guides/migrations).

### Invisible characters

An invisible character is refused anywhere in attribute text, strings and SQL bodies included:
zero-width spaces and joiners, the byte-order mark, bidirectional text controls, non-whitespace
control characters and similar code points. See the
[auth support matrix](./auth-support-matrix#policy-attribute-spelling) for why, and for the one
place variation selectors are allowed.
