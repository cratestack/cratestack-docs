# Auth Support Matrix

This document records the current executable CrateStack auth and policy surface.

The matrix categories are intentionally modeled after the public ZenStack 2025/2026 access-policy surface described in:

* `https://zenstack.dev/blog/prisma-alternative`
* `https://zenstack.dev/blog/orm-2026`

CrateStack is not trying to claim ZenStack feature parity. The goal is to make it obvious which policy patterns are
supported today, which are partial, and which are still out of scope.

## Current Semantics

Model policies:

* `@@allow(...)` and `@@deny(...)` are supported
* action names support `list`, `detail`, `read`, `create`, `update`, `delete`, and `all`
* deny wins over allow
* if no matching allow rule exists, access is denied
* canonical model-policy literals, predicates, and expressions now live in `cratestack-policy`

Procedure policies:

* `@allow(...)` and `@deny(...)` are supported
* deny wins over allow
* if no allow rule exists, invocation is denied
* canonical procedure-policy literals, predicates, and expressions now live in `cratestack-policy`

Auth-derived defaults:

* create-time `@default(auth().field)` is supported
* defaults are applied before create policy evaluation
* nested auth paths like `auth().organization.id` are supported
* defaults still do not allow arbitrary expressions or function calls

## Matrix

| Capability                                  | ZenStack-style expectation                     | CrateStack 2026 status | Notes                                                                                                                   |
|---------------------------------------------|------------------------------------------------|-----------------------|-------------------------------------------------------------------------------------------------------------------------|
| Model `@@allow`                             | Supported                                      | Supported             | `list`, `detail`, `read`, `create`, `update`, `delete`                                                                  |
| Model `@@deny`                              | Supported                                      | Supported             | Deny precedence implemented                                                                                             |
| Action alias `all`                          | Supported                                      | Supported             | Expands to list/detail/create/update/delete                                                                             |
| Read action split                           | Supported in richer engines                    | Supported             | `list` scopes `find_many`, `detail` scopes `find_unique`, `read` applies to both                                        |
| `auth() != null`                            | Supported                                      | Supported             | Model and procedure policies                                                                                            |
| `auth() == null`                            | Supported                                      | Supported             | Model and procedure policies                                                                                            |
| `field == literal`                          | Supported                                      | Supported             | Boolean, Int, String subset                                                                                             |
| `field != literal`                          | Supported                                      | Supported             | Boolean, Int, String subset                                                                                             |
| `field == auth().field`                     | Supported                                      | Supported             | Model and procedure subset                                                                                              |
| `field != auth().field`                     | Supported                                      | Supported             | Model and procedure subset                                                                                              |
| `auth().field == modelField`                | Supported                                      | Supported             | Model and procedure subset                                                                                              |
| `auth().field != modelField`                | Supported                                      | Supported             | Model and procedure subset                                                                                              |
| `field == otherField`                       | Supported in richer engines                    | Supported             | Procedure policies only                                                                                                 |
| `field != otherField`                       | Supported in richer engines                    | Supported             | Procedure policies only                                                                                                 |
| `auth().field == literal`                   | Supported                                      | Supported             | Model and procedure subset                                                                                              |
| `auth().field != literal`                   | Supported                                      | Supported             | Model and procedure subset                                                                                              |
| `&&` / `\|\|` grouping                      | Supported                                      | Supported             | Parenthesized grouping supported in parser/lowering                                                                     |
| Row-level read scoping                      | Supported                                      | Supported             | SQL-scoped on `find_many` / `find_unique`                                                                               |
| Row-level update scoping                    | Supported                                      | Supported             | SQL-scoped                                                                                                              |
| Row-level delete scoping                    | Supported                                      | Supported             | SQL-scoped                                                                                                              |
| Create-time policy checks                   | Supported                                      | Partial               | Scalar/auth checks run in-memory; relation checks use DB lookups when join columns are present in create input/defaults |
| Create-time auth defaults                   | Supported                                      | Partial               | Only `@default(auth().field)`                                                                                           |
| Procedure `@allow`                          | Supported                                      | Supported             | Runtime wrappers + routes                                                                                               |
| Procedure `@deny`                           | Supported                                      | Supported             | Deny precedence implemented                                                                                             |
| Procedure input field checks                | Supported                                      | Supported             | Direct args and `args.<field>` paths, with input/auth/input comparisons                                                 |
| DB-backed procedure auth                    | Supported in richer engines                    | Partial               | `@authorize(Model, action, args.path)` delegates to model detail/update/delete auth by id                               |
| Structured principal context                | Supported in richer engines                    | Partial               | `CoolContext` now carries `principal.actor/session/tenant/claims` plus legacy `auth()` compatibility                    |
| Relation-based auth like `auth() == author` | Supported                                      | Supported             | Single-column to-one relations that reference `id`                                                                      |
| Nested auth paths like `auth().org.id`      | Supported in richer engines                    | Supported             | Exact auth keys still win; dotted paths traverse nested auth maps                                                       |
| Relation traversal inside policies          | Supported in richer engines                    | Partial               | Recursive to-one and quantified to-many traversal are supported across model policies                                   |
| Collection predicates in policies           | Supported in richer engines                    | Partial               | Supports dotted `some` / `every` / `none` relation segments inside model policies                                       |
| Built-in policy functions                   | Supported in richer engines                    | Partial               | `hasRole('...')` and `inTenant('...')` are supported as boolean terms in model and procedure policies                   |
| Arbitrary functions in policies             | Supported in richer engines                    | Not supported         | No custom policy function plugin layer beyond the built-in term set                                                     |
| Forced server-owned fields                  | Sometimes supported with richer semantics      | Not supported         | `@default(auth().field)` is fallback-only, not override-enforcement                                                     |
| Field-level read masking                    | Sometimes supported in richer stacks           | Not supported         | Model-level access only                                                                                                 |
| Field-level write blocking                  | Sometimes supported in richer stacks           | Not supported         | Model-level access only                                                                                                 |
| Post-update input-aware policies            | Sometimes supported in richer stacks           | Partial               | Current update/delete checks are row-scoped SQL predicates                                                              |
| Durable external auth plugin engine         | Sometimes supported via plugin/runtime systems | Not supported         | Current engine is built-in and macro/runtime-local                                                                      |

## Supported Examples

### Ownership + published read

```cstack
model Post {
  id String @id @default(cuid())
  title String
  published Boolean @default(false)
  authorId String

  @@allow('all', auth() != null && auth().id == authorId)
  @@allow('read', auth() != null && published)
}
```

### List/detail split

```cstack
model Post {
  id Int @id
  title String
  published Boolean
  authorId Int

  @@allow('list', published)
  @@allow('detail', published || authorId == auth().id)
}
```

Notes:

* `list` applies to `find_many`
* `detail` applies to `find_unique`
* `read` remains the umbrella action when the same rule should apply to both

### Organization scope + role allowlist

```cstack
model Todo {
  id String @id @default(cuid())
  ownerId String
  title String
  organizationId String? @default(auth().organization.id)

  @@deny('all', auth().organization.id != organizationId)
  @@allow('all', auth().userId == ownerId || auth().organizationRole == 'owner' || auth().organizationRole == 'admin')
}
```

### Recursive relation-aware read

```cstack
model User {
  id Int @id
  email String
  banned Boolean
}

model Post {
  id Int @id
  published Boolean
  authorId Int
  author User @relation(fields:[authorId], references:[id])

  @@deny('read', author.banned)
  @@allow('read', auth() != null && published)
  @@allow('read', author.email == auth().email)
}
```

### Moderation with deny override

```cstack
auth SessionUser {
  id Int
  email String
  role String
}

model User {
  id Int @id
  email String
  suspended Boolean
}

model Post {
  id Int @id
  title String
  published Boolean
  flagged Boolean
  authorId Int
  author User @relation(fields:[authorId], references:[id])

  @@deny('read', author.suspended)
  @@deny('update', flagged && auth().role != 'admin')
  @@allow('read', published)
  @@allow('read', author.email == auth().email)
  @@allow('update', auth() == author)
}
```

Notes:

* `author.suspended` is a relation-aware boolean deny
* `author.email == auth().email` is a relation-aware ownership read rule
* deny still overrides matching allow rules

### Membership-scoped access

```cstack
auth SessionUser {
  id Int
  email String
  role String
}

model User {
  id Int @id
  email String
  banned Boolean
}

model Membership {
  id Int @id
  active Boolean
  role String
  userId Int
  user User @relation(fields:[userId], references:[id])

  @@deny('read', user.banned)
  @@allow('read', auth() != null && user.email == auth().email && active)
  @@allow('update', auth().role == 'admin' && role != 'owner')
}
```

Notes:

* combines relation-aware read checks with ordinary scalar checks
* `user.email == auth().email` stays inside the supported recursive relation boundary
* `update` remains row-scoped against the current record

### Quantified to-many traversal

```cstack
model Task {
  id Int @id
  projectId Int
  project Project @relation(fields:[projectId], references:[id])

  @@deny("read", project.memberships.some.user.banned)
  @@allow("read", project.organization.slug == auth().orgSlug && project.memberships.some.user.email == auth().email)
  @@allow("delete", project.memberships.every.active)
  @@allow("create", project.memberships.none.blocked)
}
```

Notes:

* supports mixed recursive to-one and quantified to-many segments
* `some` lowers to `EXISTS`, `none` lowers to `NOT EXISTS`, and `every` lowers to `NOT EXISTS ... NOT (...)`
* create-time relation checks work when the traversed root join columns are available from create input/default
  expansion

### Vendor catalog visibility

```cstack
auth SessionUser {
  id Int
  email String
  role String
}

model Vendor {
  id Int @id
  contactEmail String
  blocked Boolean
}

model Product {
  id Int @id
  name String
  published Boolean
  vendorId Int
  vendor Vendor @relation(fields:[vendorId], references:[id])

  @@deny('read', vendor.blocked)
  @@allow('read', published)
  @@allow('read', vendor.contactEmail == auth().email)
  @@allow('update', vendor.contactEmail == auth().email)
  @@allow('delete', auth().role == 'admin')
}
```

Notes:

* useful when ownership lives on the related row rather than the base model row
* `vendor.contactEmail == auth().email` works for read and row-scoped update
* admin delete stays a plain auth-field check

### Procedure allow + deny

```cstack
mutation procedure approvePost(args: ApprovePostInput): Post
  @allow(auth() != null && auth().role == 'admin' && publishNow)
  @deny(postId == 2)
```

### Procedure auth with nested input paths

```cstack
type ReviewPostInput {
  postId Int
  publishNow Boolean
  dryRun Boolean
  ownerEmail String
  mirrorEmail String
}

mutation procedure reviewPost(args: ReviewPostInput): Post
  @allow((auth() == null && args.dryRun) || (auth().role == 'admin' && args.publishNow && args.ownerEmail == auth().email))
  @deny(args.postId == 2 || args.ownerEmail != auth().email || args.ownerEmail != args.mirrorEmail)
```

Notes:

* `args.<field>` works for nested object input checks
* procedure policies now support input-vs-auth and input-vs-input equality/inequality
* deny still overrides allow

### Nested auth context paths

```cstack
type OrganizationScope {
  id String
  slug String
}

auth SessionUser {
  userId String
  organization OrganizationScope
}

model Todo {
  id String @id @default(cuid())
  ownerId String
  organizationId String @default(auth().organization.id)

  @@deny('all', auth().organization.id != organizationId)
  @@allow('all', auth().userId == ownerId)
}
```

Notes:

* nested auth lookups traverse structured auth objects carried in `CoolContext`
* `CoolContext` now carries a first-class `principal.actor/session/tenant/claims` shape internally
* canonical policy types are shared through `cratestack-policy`; model and procedure auth now lower onto the same runtime policy surface
* an exact auth key still wins before dotted traversal, so existing flat claims stay backward compatible

### Built-in role and tenant checks

```cstack
model AdminPanel {
  id String @id @default(cuid())
  title String

  @@allow('read', hasRole('admin') && inTenant('tenant_1'))
}

mutation procedure adminPulse(args: InspectPostInput): Post
  @allow(hasRole('admin') && inTenant('tenant_1'))
```

Notes:

* `hasRole('...')` checks the top-level `role` claim and falls back to `actor.role`
* `inTenant('...')` checks the structured `tenant.id` claim
* both functions are boolean terms that can participate in grouped `&&` / `||` expressions
* only a single string literal argument is supported today

### DB-backed procedure delegation

```cstack
type InspectPostInput {
  postId String
}

query procedure inspectPost(args: InspectPostInput): Post
  @allow(auth() != null)
  @authorize(Post, detail, args.postId)
```

Notes:

* `@authorize(Model, action, args.path)` performs an extra DB-backed model auth check before invoking the procedure body
* current delegated actions are `detail`/`read`, `update`, and `delete`
* the delegated check returns forbidden when the referenced row is missing or not visible under the caller context

## Not Supported Yet

Treat these as future work — not all of them fail the same way:

```cstack
@@allow('read', members?[userId == auth().id])
@@allow('read', members.some.user.role == hasRole('admin'))
ownerId String @default(lower(auth().email))
```

The first two are genuine parser rejections (Prisma's `?[...]` collection-predicate syntax isn't part of this grammar — use dotted `some`/`every`/`none` instead; comparing a boolean-returning term like `hasRole(...)` with `==` isn't a supported shape). The third is **not** cleanly rejected: `@default(...)` recognition only matches the exact `auth().<path>` shape, so `lower(auth().email)` isn't classified as an auth default at all — it falls through to `cratestack-migrate`'s generic function-call default handling (`ColumnDefault::Function`) and gets emitted verbatim into the DDL as `DEFAULT lower(auth().email)`. Since `auth()` isn't a real SQL function, that fails at `migrate diff`/apply time as invalid Postgres, not at schema-compile time. Don't rely on any static guarantee here — this shape reaches the database before it's caught.

## Security Notes

Current security posture is intentionally conservative:

* unsupported policy shapes fail generation instead of silently degrading
* missing allow rules deny by default
* deny rules override allow rules
* built-in policy functions remain intentionally narrow and deterministic
* unauthenticated creates that depend on required auth-derived defaults fail cleanly as forbidden
* relation-aware model policies support recursive to-one traversal plus dotted `some` / `every` / `none` segments
* create-time relation checks only succeed when the root relation join values are known from create input/defaults;
  otherwise the relation predicate evaluates false and the create is denied

## Test Coverage

Current coverage for the supported matrix lives primarily in:

* `crates/cratestack-pg/tests/include_schema.rs`
* `crates/cratestack-pg/tests/policy_db.rs`
* `crates/cratestack-pg/tests/policy_db_advanced.rs`
* `crates/cratestack-pg/tests/policy_db_auth_engine.rs`
* `crates/cratestack-pg/tests/policy_db_recursive.rs`

Those tests cover:

* model allow/deny precedence
* procedure allow/deny precedence
* route-level forbidden vs hidden behavior
* auth-derived defaults across direct and HTTP paths
* recursive relation traversal plus dotted `some` / `every` / `none` model policy segments
* create-time DB-backed relation policy checks when root join values are present in the create input
* built-in `hasRole('...')` and `inTenant('...')` checks across direct, SQL-scoped, and procedure authorization paths
* non-invocation of denied procedures

## Remaining Limits

Current limits that still matter in practice:

* create-time relation checks are partial: they only work when the root relation join values are known from create input
  or auth-derived default expansion
* procedure DB-backed auth is partial: `@authorize(Model, action, args.path)` delegates to model auth by referenced id,
  but there is still no general DB-querying procedure policy language
* CoolContext now carries a first-class `principal.actor/session/tenant/claims` model, but explicit impersonation,
  acting-as, and delegated-session semantics are still unsupported
* arbitrary policy functions beyond `hasRole('...')` and `inTenant('...')` are still unsupported
* field-level read masking and field-level write blocking are still unsupported
