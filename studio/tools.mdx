---
title: Studio Power Tools
description: SQL preview, query plans, drift detection, CSV/JSON export, schema search, and the audit log — the admin surface beyond CRUD.
---

# Studio Power Tools

These surfaces sit on top of the
[read](./read-api) and [write](./write-api) APIs. They're optional —
none of them change the CRUD contract — but they're what makes Studio
useful as an admin tool rather than just a row browser.

## SQL preview

```
GET /api/targets/:key/models/:model/sql?op=list|get|create|update|delete&pk=…&explain=true
```

Renders the SQL Studio _would_ run for an operation without touching
the database. Lets you understand what the abstraction is doing
before pulling the trigger, or copy it into a query tool to tweak by
hand. Bound parameters are returned alongside the SQL text so you
don't have to read the placeholders.

```bash
curl 'http://127.0.0.1:7878/api/targets/catalog/models/Post/sql?op=update&pk=p1'
# {
#   "driver": "postgres",
#   "sql": "WITH updated AS ( UPDATE \"posts\" SET \"title\" = $1 WHERE \"id\" = $2 RETURNING * ) ...",
#   "params": [
#     { "index": 1, "binding": "title", "kind": "text" },
#     { "index": 2, "binding": "p1",    "kind": "text" }
#   ]
# }
```

API-backed targets return `501 UNSUPPORTED` — Studio doesn't render
SQL it doesn't run.

### Query plans (`explain=true`)

Adding `explain=true` asks the driver to *plan* the rendered
statement and returns the result in a `plan` field alongside the SQL:

```bash
curl 'http://127.0.0.1:7878/api/targets/catalog/models/Post/sql?op=list&explain=true'
# {
#   "driver": "sqlite",
#   "sql": "SELECT json_object('id', \"id\", 'authorId', \"author_id\", …) AS row FROM \"posts\" …",
#   "params": [ { "index": 1, "binding": "cursor (NULL on first page)", "kind": "text" } ],
#   "plan": "SCAN posts USING INDEX sqlite_autoindex_posts_1"
# }
```

<Frame caption="The same request from the UI — tick **Explain** next to **Show SQL**.">
  <img src="/images/studio/studio-explain.png" alt="Studio SQL preview showing rendered SQL, bound parameters, and a SQLite query plan" />
</Frame>

This is the one part of the preview endpoint that reaches the
database, which is why it's opt-in rather than on by default:
rendering SQL is pure and instant, planning it is a round trip.

Two guarantees worth stating plainly:

- **Studio never runs `EXPLAIN ANALYZE`.** There is no config knob, no
  query parameter, and no code path that emits it — so "plan this"
  can never become "execute this".
- **Only reads are planned.** `create` / `update` / `delete` return
  the preview plus a note instead of a plan. Beyond the
  defence-in-depth argument, the mutation previews bind placeholder
  sample values, so asking Postgres to plan them would fail on type
  inference rather than produce a plan worth reading.

Per-dialect specifics:

| Driver     | Statement issued        | Notes                                                                    |
| ---------- | ----------------------- | ------------------------------------------------------------------------ |
| Postgres   | `EXPLAIN <sql>`         | Plain `EXPLAIN`; costs and node types, no timings.                        |
| SQLite     | `EXPLAIN QUERY PLAN <sql>` | Not bare `EXPLAIN`, which dumps SQLite's bytecode program rather than the `SCAN` / `SEARCH … USING INDEX` shape you actually want. |
| API-backed | —                       | `501 UNSUPPORTED`, same as the SQL preview itself.                        |

`op=get` needs a `pk=` to bind against; without one you get a note
saying so rather than a plan. A backend that can't plan at all still
returns the SQL preview you successfully asked for — a missing plan
never costs you the preview.

## Drift

```
GET /api/targets/:key/drift
```

Compares the schema's declared columns to the live database
(`information_schema` on Postgres, `PRAGMA table_info` on SQLite) and
reports the result per model:

| `status`         | Meaning                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `ok`             | Live columns match the schema's declared shape.                          |
| `drift`          | Some columns differ — `missing_columns` and `extra_columns` are populated. |
| `missing_table`  | The table doesn't exist (the migration hasn't been run).                 |
| `unsupported`    | This target can't be inspected (API-only).                               |
| `skipped`        | Resolution failed (no `@id` or unsupported PK type).                     |

```bash
curl 'http://127.0.0.1:7878/api/targets/catalog/drift'
# {
#   "target": "catalog",
#   "models": [
#     { "model": "Post",     "status": "ok" },
#     { "model": "Customer", "status": "drift", "missing_columns": ["phone"] }
#   ]
# }
```

The UI renders a small `⚠ drift` chip next to drifting models in the
sidebar and `✕ table` for missing tables.

## CSV/JSON export

```
GET /api/targets/:key/models/:model/export?format=csv|json&limit=N
```

Pulls up to `limit` rows (capped at **10 000**) through cursor
pagination internally and returns one body. Sets
`Content-Disposition: attachment; filename="<target>-<table>.<ext>"`
so the browser downloads the file straight from the link.

CSV uses RFC-4180-style escaping (quote-wrap on commas, quotes, or
newlines; double up embedded quotes). JSON is a flat array of objects,
field names as keys.

```bash
curl 'http://127.0.0.1:7878/api/targets/catalog/models/Post/export?format=csv&limit=1000' \
  -o posts.csv
```

The export endpoint is bounded — it's for "developer pulling a sample
for a notebook," not "ETL." For multi-million-row dumps, hit the
database directly.

## Schema search

```
GET /api/targets/:key/search?q=<term>
```

Case-insensitive substring over models, fields (including the
`Model.field` path and the field's type), enums and their variants,
mixins, types, and procedures. Empty query returns `{ "hits": [] }`.

```bash
curl 'http://127.0.0.1:7878/api/targets/catalog/search?q=author'
# {
#   "hits": [
#     { "kind": "field", "model": "Post", "name": "author",  "detail": "Customer required" },
#     { "kind": "field", "model": "Post", "name": "authorId","detail": "Int required" }
#   ]
# }
```

Hit `kind` is one of `model`, `field`, `type`, `enum`, `mixin`,
`procedure`. The UI renders an inline dropdown directly under the
search bar in the header.

## Audit log

```
GET /api/audit?limit=N
```

Studio holds every successful write (CREATE / UPDATE / DELETE) in an
in-memory ring buffer, capped at **500** entries, FIFO when full.
Entries are returned newest-first:

```json
{
  "entries": [
    {
      "id": 42,
      "at": "2026-05-15T12:34:56Z",
      "target": "catalog",
      "model": "Post",
      "op": "UPDATE",
      "pk": "p1"
    }
  ]
}
```

The UI's "Audit" button in the header opens an overlay listing the
most recent 100 entries:

<Frame caption="The audit overlay after two edits to `catalog/Post`, newest first.">
  <img src="/images/studio/studio-audit.png" alt="Studio audit overlay listing two UPDATE entries against catalog/Post with timestamps" />
</Frame>

### Persisting the log

By default the ring buffer lives in process memory only, so restarting
the binary clears it. Set `audit_file` to also append every entry to a
JSONL file, replayed on boot:

```toml
[workspace]
name = "acme"
audit_file = ".cratestack-studio/audit.jsonl"   # relative to studio.toml
```

- **Opt-in.** Unset, Studio writes nothing to your filesystem.
  Silently starting to drop a log file into someone's repo is a
  behavioural change they didn't ask for.
- **Studio-local, never your database.** The sink is a file next to
  `studio.toml`. Studio has never created a table, and persisting
  audit rows into the target's own schema would mean migrating the
  user's database behind their back — wrong twice over for `ro`
  targets and for API-only targets that have no database at all.
- **Append-only, never rotated.** That's what makes it cheap to write
  under a lock and safe to `tail -f`. Not rotating is deliberate: an
  audit log that silently discards its own history is worse than no
  audit log. The in-memory ring the API serves stays capped however
  large the file grows.
- **Ids resume across restarts.** Boot replays the file, keeps the
  newest entries up to the cap, and continues numbering above the
  highest id it saw — so resumed ids never collide with historical
  ones.

Failure handling is deliberately asymmetric:

| When                   | Behavior                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| At boot                | **Fatal.** You asked for persistence explicitly; booting into a state where Studio silently isn't persisting would misreport what it's doing. |
| On append, mid-flight  | Logged once at `error`, then demoted to `debug`. Losing an audit line is bad; refusing the CREATE/UPDATE/DELETE the operator asked for is worse. |
| Torn or hand-edited line at replay | Skipped and counted, not fatal — a half-written tail from a `kill -9` must not brick boot. |

## Constraint errors → VALIDATION_ERROR

Studio used to surface driver constraint failures as
`DATABASE_ERROR` (500). Phase 4 maps the well-known codes back to the
same per-field `VALIDATION_ERROR` envelope as the in-process
validators:

| Source                                            | Code            |
| ------------------------------------------------- | --------------- |
| PG `23505` / SQLite `SQLITE_CONSTRAINT_UNIQUE` / `…_PRIMARYKEY` | `UNIQUE`        |
| PG `23503` / SQLite `SQLITE_CONSTRAINT_FOREIGNKEY`             | `FOREIGN_KEY`   |
| PG `23502` / SQLite `SQLITE_CONSTRAINT_NOTNULL`                | `REQUIRED`      |
| PG `22001` (string truncation)                                 | `LENGTH`        |
| PG `22P02` (invalid text representation)                       | `TYPE_MISMATCH` |
| PG `23514` / SQLite `SQLITE_CONSTRAINT_CHECK`                  | `REGEX`         |

Unrecognized errors still come back as `DATABASE_ERROR`.

The wire envelope is identical to the in-process validator path
(see the [write API](./write-api#validators) page), so the UI doesn't
care whether the rejection came from Studio's pre-flight check or the
database's constraint engine.
