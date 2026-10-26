---
title: Reducing payload size
description: Which levers actually shrink CrateStack responses and storage, ranked by measured effect — compression, CBOR, projections, then type choices in the .cstack schema, including when enums beat strings and what explicit enum ordinals would add.
---

# Reducing payload size

Most of a CrateStack response is decided by the `.cstack` schema: which fields exist, what
type each one has, and what a client is allowed to ask for. This guide ranks the levers by
what they measurably save, so you spend schema churn where it pays.

**The short version:**

1. Compress responses. On a list endpoint that alone removes 65–75 % of the bytes.
2. Let clients speak CBOR. It is already the default, except for the TypeScript REST client.
3. Ask for less: `?fields=`, `includeFields[path]`, `@@paged`, `@server_only`.
4. Then pick compact types. Model closed sets as `enum`, not `String`. Explicit enum
   ordinals are a **proposed** feature (see [below](#enum-ordinals-proposed)). They
   help most where nothing compresses the bytes.

Every number below was measured with the framework's own CBOR serializer
(`minicbor-serde` 0.7.1, configured as `CborCodec` configures it) and `serde_json`. The method
and raw output are in the framework design doc
[`docs/design/enum-ordinals.md` §8](https://github.com/cratestack/cratestack/blob/main/docs/design/enum-ordinals.md).

## What the levers are worth

A list response of 500 rows, each `{ id: Uuid, eventType, status, createdAt: DateTime, amount: Decimal }`,
with varied data:

| Shape | CBOR | CBOR + gzip | JSON | JSON + gzip |
|---|---|---|---|---|
| `eventType` and `status` as strings | 59.4 KB | 18.7 KB | 79.4 KB | 21.2 KB |
| …as integer enum ordinals | 47.4 KB | 18.4 KB | 66.4 KB | 20.7 KB |
| …and `createdAt` as an integer epoch | 37.4 KB | 16.2 KB | 59.9 KB | 19.5 KB |

Read that table in both directions:

- **Compression dwarfs type choices.** Gzip takes the string-y CBOR body from 59 KB to 19 KB.
  Switching both enums to ordinals then saves another 1.3 %. Repeated field names and repeated
  enum strings are exactly what a compressor eats.
- **Without compression, types matter.** Ordinals cut the raw CBOR body by 20 %. An epoch
  timestamp then removes another 10 KB, a further 17 % of the original. Some bytes are never compressed: `application/cbor-seq` streams,
  sealed signed-transport payloads, outbox rows, a mobile client on a proxy that strips
  `Content-Encoding`. Type choices are what you have there.

## 1. Compress responses

CrateStack does not compress for you. The generated router is a plain `axum::Router`, so
`tower-http`'s compression layer goes on it like any other layer:

```toml
# Cargo.toml
tower-http = { version = "0.7", features = ["compression-gzip", "compression-br"] }
```

```rust
use tower_http::compression::CompressionLayer;

let app = axum::Router::new()
    .nest("/api", router)
    .layer(CompressionLayer::new());
```

Browsers, `dart:io`'s `HttpClient` and `reqwest` (with its `gzip` feature) decompress
transparently. The framework does not test this layer together with the
[signed transport](./signed-transport) envelope layer. If you use both, check one sealed
round trip yourself.

## 2. Let clients speak CBOR

Generated routes answer `application/cbor` by default and `application/json` when the client
asks for it in `Accept` ([HTTP transport contract](../architecture/http-transport-contract)).
CBOR is smaller than JSON for the same value:

| Value | CBOR | JSON |
|---|---|---|
| `Boolean` | 1 B | 4–5 B |
| `Uuid` | 17 B (binary) | 38 B |
| `Int` 3 / 300 / 70 000 | 1 / 3 / 5 B | 1 / 3 / 5 B |
| an enum value `PendingReview` | 14 B | 15 B |
| `DateTime` | 21–32 B (text) | 22–32 B |

Which clients use it:

- **Rust client:** CBOR.
- **Dart client:** CBOR by default (`application/cbor`). See [Dart HTTP transport](./dart-http-transport).
- **TypeScript, `transport rpc`:** native CBOR through `@cratestack/cbor` by default.
  `--no-native-cbor` falls back to JSON.
- **TypeScript, REST:** JSON only. The REST runtime has no codec seam
  ([TypeScript client generation](./typescript-client-generation#the-cbor-codec)). Compression
  is the lever for a REST browser client.

## 3. Ask for less

These remove bytes outright rather than encoding them more tightly. They work the same over
REST and RPC.

- **`?fields=`** limits a read to the named fields. `includeFields[path]` does the same for an
  included relation. Generated clients expose both through their selection builders
  ([client runtime](../architecture/client-runtime)). A `@computed` field left out of
  `?fields=` is not even resolved ([computed fields](./computed-fields)).
- **`@@paged`** with a `limit` gives an unbounded list a page size
  ([pagination](./pagination)).
- **`@server_only`** keeps a field off the wire entirely, for columns no client should see.

## 4. Choose compact types in the schema

### Where each type is a string, and where it is not

| `.cstack` type | Postgres column | On the wire |
|---|---|---|
| `String` | `TEXT` | text |
| `enum` | `TEXT` + membership `CHECK` | text (the variant name) |
| `DateTime` | `TIMESTAMPTZ` (8 B) | text (RFC 3339) |
| `Uuid` | `UUID` (16 B) | 16 B binary on CBOR, text on JSON |
| `Decimal` | `NUMERIC` | text, deliberately ([scalars](../reference/scalars#serialization)) |
| `Int` | `BIGINT` | integer |
| `Boolean` | `BOOLEAN` | boolean |

So in Postgres a `DateTime` is **not** stored as a string. It is an 8-byte `TIMESTAMPTZ`, and
it becomes a string only on the wire, on both codecs. The embedded SQLite backend is different:
every column is declared `BLOB`, and a `DateTime` is stored as RFC 3339 text
([offline-first SQLite](./offline-first-sqlite)), so there a timestamp really is a string at
rest.

### Closed sets: use an `enum`, not a `String`

A `status String` and a `status Status` cost the same bytes today: both go out as text. Use the
enum anyway, because the gains are correctness:

- The column gets a membership `CHECK`, so the database refuses a typo'd status.
- A filter like `?status=Pendng` is refused, and the error names the accepted values.
- Generated clients get a real type: a TypeScript string union, a Dart `enum`, a Rust `enum`.
- Policy literals (`auth().role == admin`) are checked against the variants at compile time.

It also puts the field in a position to move to ordinals later without touching application
code (next section). Good candidates: statuses, event kinds, roles, channels, categories.

Keep `String` for sets that churn outside your release cycle. Currencies are `String @iso4217`
for exactly that reason ([choosing types for money](../reference/scalars#choosing-types-for-money)).
Adding an enum variant is a schema change and a client regeneration.

Don't shorten variant names into codes (`PR` for `PendingReview`) to save bytes. Under
compression the saving is near zero, and the cost is a schema nobody can read.

### Identifiers

`Int` ids are 1–9 bytes. `Uuid` is 17 bytes on CBOR and 38 on JSON. A `Cuid` is text. Choose by
generation and exposure needs first: a `Uuid` can be minted offline and does not leak row
counts. Size is a tiebreaker.

### Timestamps

Keep `DateTime`. An `Int` epoch is smaller on the wire (5–9 B against 21–32 B), but you give up
`@default(now())` (it requires a `DateTime` field), `TIMESTAMPTZ` semantics and operators in SQL,
and RFC 3339 parsing in filters such as `?createdAt__gte=`. Consider an epoch only on a
high-volume, append-only table that is read by machines and never filtered by date in a URL.

### Money

Keep `Decimal`. Integer minor units are a few bytes smaller, but they move the scale into
convention instead of the type.

### Field names

Every row repeats every key, so `createdAt` costs 10 bytes per row before its value. Pick clear
names, not short ones; `?fields=` and compression handle the rest. No attribute renames a field
on the wire only. `@rename(from = "…")` is a [migration marker](./migrations).

## Enum ordinals (proposed)

<Warning>
**Not shipped.** No CrateStack release stores or sends an enum as its ordinal. This section
describes the design in
[`docs/design/enum-ordinals.md`](https://github.com/cratestack/cratestack/blob/main/docs/design/enum-ordinals.md),
which is being built in slices, so you can shape your schema for it today. Writing `Pending = 1`
in a `.cstack` file is refused: on 0.16.0 it is a parse error, and on `main` `cratestack check`
says the enum "declares explicit ordinals, which this release parses but does not generate".
</Warning>

The proposal stores and sends an enum as a small integer instead of its name, with the mapping
written in the schema:

```cstack
enum PaymentStatus {
  Pending = 1
  Approved = 2
  Rejected = 3
  Refunded = 5

  @@reserved(4)   // was Settled; never reuse
}
```

The column becomes a `SMALLINT` (2 B) instead of `TEXT`. The value goes out as a 1–3 byte integer
instead of its name. Application code keeps using names: TypeScript keeps its
`'Pending' | 'Approved'` union, Dart keeps its enum constants, and URLs keep
`?status=Approved`. URLs take names only: `?status=2` will be refused, so a query string
reads the same before and after an enum becomes ordinal.

### Why the mapping must be explicit and enforced

The tempting shortcut is to use each variant's position in the declaration. That breaks
silently the first time someone sorts the variants or inserts one in the middle: every stored
row now means a different status, and nothing errors. So the design makes the mapping explicit
and **append-only**:

- Every variant has a number, or none does. Numbers are unique.
- `cratestack migrate diff` refuses to change a variant's number, to remove a variant without
  listing its number in `@@reserved`, and to reuse a number.
- Renaming a variant while keeping its number is allowed and moves no data.
- `cratestack diff` reports removed and renamed variants as breaking. Today it does not look at
  enums at all; the design fixes that for string enums too.

### "We don't need readable values in the database any more"

The argument for ordinals is that the schema is the decoder: anyone with the `.cstack` file, an
AI assistant included, can read `status = 3` as `Rejected`. That is true where the schema
travels with the data:

- Generated clients and Studio show names.
- `psql`, BI tools, a backup restored years later, and audit or outbox payloads show integers.

So use ordinals where values are high-volume, stable and machine-read: event kinds, statuses on
hot tables, anything streamed. Keep names for small tables and anything an on-call engineer or
auditor reads raw.

### Preparing for ordinals today

- Model closed sets as `enum` now. Converting an enum to ordinals is planned to be one schema
  edit that `migrate diff` turns into a data migration. Converting a `String` column is a
  redesign.
- Treat variant order as meaningless and never reorder for meaning. Leave gaps in your mental
  numbering where you expect growth.
- Never delete a variant that has ever been stored. The design keeps the number reserved
  forever, and your data already depends on the name today.

## Measuring your own API

Compare sizes per codec and with compression, against a real endpoint:

```bash
# raw CBOR (the default)
curl -s -o /dev/null -w '%{size_download}\n' -H 'Accept: application/cbor' "$URL"
# raw JSON
curl -s -o /dev/null -w '%{size_download}\n' -H 'Accept: application/json' "$URL"
# compressed on the wire (needs the CompressionLayer above)
curl -s -o /dev/null -w '%{size_download}\n' -H 'Accept: application/json' \
     -H 'Accept-Encoding: gzip' "$URL"
# and with a projection
curl -s -o /dev/null -w '%{size_download}\n' -H 'Accept: application/cbor' "$URL?fields=id,status"
```

`%{size_download}` counts bytes as received, so the gzip line shows the compressed size.
