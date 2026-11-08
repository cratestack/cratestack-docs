---
title: Mixins
description: Reuse field sets across models with top-level mixin declarations and model @use(...) expansion.
---

# Mixins

Mixins provide field reuse for `.cstack` models. They are a schema authoring convenience, not a
runtime inheritance feature.

## Syntax

Declare a top-level `mixin` block and apply it inside a model with `@use(...)`.

```cstack
mixin AuditFields {
  createdAt DateTime @default(dbgenerated())
  updatedAt DateTime @default(dbgenerated())
}

model Post {
  @use(AuditFields)

  id Int @id
  title String
}
```

You can apply more than one mixin:

```cstack
mixin AuditFields {
  createdAt DateTime @default(dbgenerated())
  updatedAt DateTime @default(dbgenerated())
}

mixin SoftDelete {
  deletedAt DateTime?
}

model Post {
  @use(AuditFields, SoftDelete)

  id Int @id
  title String
}
```

## Semantics

CrateStack expands mixin fields into the model before semantic validation and before Rust, Dart,
and TypeScript code generation.

That means:

* generated clients and generated server code see normal model fields after expansion
* validator rules run on the expanded model field set
* mixins do not create a separate generated runtime type

## Rules

Current mixin support is intentionally narrow:

* mixins are only supported as top-level declarations
* a mixin may be declared in another file and brought in with `import` *(since 0.19.0)*; a model in one file can `@use` a mixin from another. See [Multi-file Schemas](./multi-file-schemas)
* `@use(...)` is only supported inside `model` blocks
* mixins contain fields, not model-level attributes
* mixins must not declare `@id`
* model-local fields win on name conflicts with mixin fields

Example of local override:

```cstack
mixin Timestamps {
  createdAt DateTime
}

model Post {
  @use(Timestamps)

  id Int @id
  createdAt DateTime?
}
```

In that example, the model's `createdAt DateTime?` definition wins.

## Non-goals

Mixins are not:

* polymorphism
* inheritance between generated model types
* a way to share model `@@...` attributes
* a way to declare shared primary keys
