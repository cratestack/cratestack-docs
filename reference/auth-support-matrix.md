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

Field policies — **rejected at parse time**:

* a **field-level** `@allow(...)` / `@deny(...)` is a compile error, on all
  five field-bearing declaration kinds: `model`, `view`, `mixin`, `type`
  and the `auth` block. The error names the offending field
* it used to parse, report `schema OK`, sit in the IR, and be read by
  **nothing** — an annotation that reads as access control and enforces
  none. The field reached every caller the model-level read policy
  admitted, exactly as if it were absent
* what to reach for instead: model/view-level `@@allow` / `@@deny` for row
  visibility, [`@readonly`](./field-attributes#exposure-controls) to keep a
  field out of generated inputs, and
  [`@server_only`](./field-attributes#exposure-controls) to keep it out of
  client responses
* this targets the field-position, single-`@` case only — procedure-level
  `@allow` / `@deny` and model/view-level `@@allow` / `@@deny` are
  untouched

<Note>
Only half of [#679](https://github.com/cratestack/cratestack/issues/679) is
closed. Unknown field attributes are still accepted generally, so a
misspelled `@raedonly` silently drops `@readonly` and leaves the field
writable. Catching that needs a generic unknown-attribute pass, which is
an intentional non-choice today — so don't rely on the parser to catch a
typo'd exposure attribute.
</Note>

Auth-derived defaults:

* create-time `@default(auth().field)` is supported
* defaults are applied before create policy evaluation
* nested auth paths like `auth().organization.id` are supported
* defaults still do not allow arbitrary expressions or function calls

## Policy attribute spelling

<Warning>
**Unreleased.** These rules are on `main` and in no published release yet (framework
[CHANGELOG](https://github.com/cratestack/cratestack/blob/main/CHANGELOG.md), `## Unreleased`,
"Security: policy attributes the generator skipped are refused (GHSA-69g4-xvcm-vm2j)", breaking).
**Affected:** procedure `@allow` / `@deny` / `@authorize` and model `@@allow` / `@@deny` in every
release 0.2.0–0.14.0, view `@@allow` / `@@deny` from 0.4.2, and `query` `@allow` / `@deny` in
0.11.0–0.14.0.
</Warning>

Through 0.14.0 the generator applied a policy attribute only when its text was exactly the
documented form and **silently skipped** anything else, while `cratestack check` reported
`schema OK`. A skipped `@deny` or `@@deny` makes a declaration more permissive than written: a
procedure with `@deny(hasRole("banned")) // note` answered `200 OK` to a `banned` caller, and a
skipped `@authorize` let the check pass without consulting the database. The skipped spellings
were:

* a space or tab before `(` (`@deny (…)`), a space after `@`, another case (`@Deny`, `@@DENY`)
  or a typo (`@deyn`, `@authorise`, `@@deyn`)
* an invisible character in the name, such as a zero-width space inside `@deny`
* anything after the closing `)`: a `// comment`, `;`, `,`, a word
* the attribute after another one on the same line (`@no_idempotency @deny(…)`)
* `@deny` with no argument list
* a model rule naming an action no slot generates (`@@deny("raed", …)`,
  `@@deny("read,update", …)`), or a view `@@deny` naming anything but `read` or `all`
* a `@deny(…)` written above a procedure's or query's signature after a blank line: it attached
  to the declaration *before* it

A rule could also be applied but never match: an invisible character inside its string
(`hasRole("ban` + a zero-width space + `ned")`) compares against a role no caller has.

Each of these is now a schema error that names the declaration and the attribute, and the
generator re-checks every attribute whose name reads as `allow`, `deny` or `authorize`: if one
did not become a rule, `include_*_schema!` fails with a `compile_error!`.

### The accepted forms

| Where | Form |
| --- | --- |
| model | `@@allow("action", expression)`, `@@deny("action", expression)`; either quote; action one of `all`, `read`, `list`, `detail`, `create`, `update`, `delete` |
| view | `@@allow("read", expression)`; `@@deny("read" or "all", expression)`; either quote (a single-quoted view `@@allow`, refused through 0.14.0, is accepted) |
| procedure | `@allow(expression)`, `@deny(expression)`, `@authorize(Model, action, args.path)` with exactly three arguments and an action of `detail`, `read`, `update` or `delete` |
| query | `@allow(expression)`, `@deny(expression)` |

The line ends at the closing `)`, apart from a trailing `// comment`, which is dropped before
anything reads the attribute (`//` inside a string literal is not a comment).

A procedure accepts only `@allow`, `@deny`, `@authorize`, `@api_version`, `@status`,
`@deprecated`, `@stream`, `@no_idempotency`, `@no_rate_limit`, `@isolation` and `@mcp`; a query
only `@@sql`, `@allow` and `@deny`. Any other name, case or typo is refused with a suggestion, and
so are whitespace before `(`, anything after the closing `)`, a missing argument list where one
is required, and an argument list on `@stream`, `@no_idempotency` or `@no_rate_limit`. Several
attributes on one procedure or query line are each read (`@no_idempotency @deny(…)`); attributes
run together with no space (`@deny(x)@allow(y)`) are refused.

### Which declaration an attribute belongs to

Procedure and query attributes sit under the signature with no braces, so layout decides:

1. **The attributes of a declaration are the lines under its signature, up to the first blank
   line.** A blank line between the signature and its attributes, or among them, is refused.
2. A `//` or `///` comment line does not end the run: it may stand between the signature and its
   first attribute, or between two attributes (refused through 0.14.0).
3. **A run may not lead straight into the next declaration.** Leave a blank line after the last
   attribute (and any comment lines after it), or the schema is refused.

### Invisible and look-alike characters

Refused anywhere in attribute text, strings and SQL bodies included, on field, `@@`, procedure and
query attributes:

* every Unicode `Default_Ignorable_Code_Point` (zero-width space, joiner and non-joiner, word
  joiner, byte-order mark, soft hyphen, direction marks, tag characters, and others), plus a few
  blank-drawing characters that property leaves out (the Braille pattern blank, U+2800, among
  them) and the control characters that are not whitespace
* a variation selector anywhere in a policy attribute; elsewhere only right after a visible
  non-ASCII character, where it picks a presentation (an emoji, a CJK variant)

Refused anywhere, comments included: bidirectional text controls (U+202A–U+202E,
U+2066–U+2069), ESC and U+009B. A character shown as a line break but not parsed as one (a lone
carriage return, vertical tab, form feed, NEL, U+2028, U+2029) is refused when text follows it
on the line. `\r\n` line endings are unaffected, and so is visible non-ASCII text. Some ordinary
text is refused too, even inside a string: an emoji built with a zero-width joiner or tag
characters, a keycap emoji, and words spelled with a zero-width joiner or non-joiner.

### Upgrading

Some schemas that still check behave differently, **with no error**. Review these before
deploying:

* **An `@allow(…)` or `@@allow(…)` with a trailing comment, or sharing a procedure line with
  another attribute, now applies.** Through 0.14.0 it was skipped, which left that declaration
  or action closed by default, so this is the one change that widens access with no error.
  Confirm each such rule grants what it says. The same applies to `@no_rate_limit`,
  `@no_idempotency`, `@stream`, `@deprecated`, `@@soft_delete`, `@@audit` and `@@subscribe`.
* **An attribute named inside a field's `// comment` no longer applies.** See
  [Field attributes](./field-attributes#trailing-comments).

Run `cratestack check` from this release over every schema, including ones consumed only through
`include_client_schema!`. Each refusal names an attribute that was not enforced (or, with an
invisible character inside its string, never matched) on an affected release: treat that
declaration as having run without it, and review its access history for the callers the rule
names. The framework CHANGELOG entry lists `grep` commands for finding candidates before
upgrading; a misspelled name or one hiding an invisible character does not match them, so only
`cratestack check` finds those.

## Relation filters and sorts

*(since 0.13.0, server role)* A relation filter or relation sort reads the related table in a
correlated subquery. That subquery now applies the related model's **read** policy (its
`@@allow` / `@@deny` for `read` and `list`, the same scope `find_many` applies to that model) and
its `@@soft_delete` filter. This covers REST list parameters (`?author.email=`), `where=`, `or=`
and `sort=`; RPC `model.<M>.list` (`filters`, `where`, `or`, `sort`); `@@paged` `totalCount`; the
typed Rust builder (`post::author().email().eq(..)`, `.asc()` / `.desc()`); to-one paths, to-many
`some` / `every` / `none`, multi-hop paths (each hop applies its own model's scope), and every
operator. In-process `update_many` and `delete_many` apply the related model's read scope in their
relation subqueries too.

**A related row the caller cannot read behaves as if it did not exist**, matching `?include=`,
which already returned such a row as `null`:

* a to-one filter never matches it, `ne` and `isNull` included
* `none` and `every` over only hidden children are vacuously true
* a relation sort key through it reads as `NULL`, sorted last
* **a related model with no `@@allow` for `read`, `list` or `all` matches nothing**: it is default-deny for direct reads,
  and now for relation paths too. If you filter or sort through such a model, add the
  `@@allow("read", ...)` that describes who may see it

From 0.2.0 through 0.12.0 the subquery applied neither the policy nor the soft-delete filter, so a
caller could test, and order by, column values of related rows they could not read, including
tombstoned rows, and with `startsWith` recover a hidden string one character at a time
(GHSA-p55v-6xv5-93p3, see the 0.13.0 section of the
[framework CHANGELOG](https://github.com/cratestack/cratestack/blob/main/CHANGELOG.md)). Clients
that relied on filtering through rows they cannot read see fewer results after upgrading; that is
the fix.

**Self-relations** (`manager User? @relation(fields:[managerId], references:[id])`) used to render
uncorrelated, so relation filters and sorts over them, **and read policies that traverse one**
(`@@allow("read", manager.name == ...)`), matched every row or none. On the server role they now
correlate through the outer row. Audit any policy that traverses a self-relation: on 0.12.0 and
earlier it may have admitted rows it should not have.

**Hand-built relation filters and sorts** take the related model's scope explicitly. Every public
constructor of a relation hop (`FilterExpr::relation`, `relation_some`, `relation_every`,
`relation_none`, `RelationFilter::new`, `RelationHop::new`, and `OrderClause::relation_scalar`)
takes a `RelatedReadScope`, with no default. Pass `<RELATED>_MODEL.related_read_scope()`.
`RelatedReadScope::Unscoped` is the named escape hatch for trusted server code that deliberately
reads the raw related table; never use it for a filter or sort whose values a caller controls.
The new `scope` field on `RelationFilter` and `RelationHop` is public, so struct literals must set
it too. `OrderClause::relation_scalar` now takes the terminal column instead of a pre-rendered SQL
string, multi-hop sorts use `OrderClause::relation_path(&hops, column, direction)`, and
`OrderTarget::RelationScalar` is now `{ hops, column }`. `order_value_sql` renders no scope: do
not build a server-side sort from it. `preview_scoped_sql` renders the related scope it executes;
`preview_sql` (without a context) renders no authorization scope at all.

To check exposure on an affected version, search access logs for list requests with dotted filter
or sort keys (`?author.email=`, `where=`, `sort=author.`) against models whose related models have
row-level read policies or `@@soft_delete`. RPC `model.<M>.list` carries the same keys in its POST
body, which access logs usually do not record.

Unchanged: `@@internal("read")` removes only a model's own routes, so relation paths and
`?include=` through an internal model are still governed by its read policy. The embedded role
enforces no policy by design; its relation subqueries ignore the scope, still see tombstoned
related rows, and still render self-relations uncorrelated.

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
| Related-model read scope in relation filters and sorts | Supported                           | Supported             | Since 0.13.0, server role; see [Relation filters and sorts](#relation-filters-and-sorts)                                 |
| Row-level update scoping                    | Supported                                      | Supported             | SQL-scoped                                                                                                              |
| Row-level delete scoping                    | Supported                                      | Supported             | SQL-scoped                                                                                                              |
| Create-time policy checks                   | Supported                                      | Partial               | Scalar/auth checks run in-memory; relation checks use DB lookups when join columns are present in create input/defaults |
| Create-time auth defaults                   | Supported                                      | Partial               | Only `@default(auth().field)`                                                                                           |
| Procedure `@allow`                          | Supported                                      | Supported             | Runtime wrappers + routes                                                                                               |
| Procedure `@deny`                           | Supported                                      | Supported             | Deny precedence implemented                                                                                             |
| Procedure input field checks                | Supported                                      | Supported             | Direct args and `args.<field>` paths, with input/auth/input comparisons                                                 |
| DB-backed procedure auth                    | Supported in richer engines                    | Partial               | `@authorize(Model, action, args.path)` delegates to model detail/update/delete auth by id                               |
| Structured principal context                | Supported in richer engines                    | Partial               | `CratestackContext` now carries `principal.actor/session/tenant/claims` plus legacy `auth()` compatibility                    |
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

* nested auth lookups traverse structured auth objects carried in `CratestackContext`
* `CratestackContext` now carries a first-class `principal.actor/session/tenant/claims` shape internally
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
* CratestackContext now carries a first-class `principal.actor/session/tenant/claims` model, but explicit impersonation,
  acting-as, and delegated-session semantics are still unsupported
* arbitrary policy functions beyond `hasRole('...')` and `inTenant('...')` are still unsupported
* field-level read masking and field-level write blocking are still unsupported
