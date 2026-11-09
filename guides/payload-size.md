---
title: Reducing payload size
description: Which levers actually shrink CrateStack responses and storage, ranked by measured effect — compression, CBOR, projections, then type choices in the .cstack schema, including when enums beat strings and when to store them as explicit ordinals.
---

# Reducing payload size

Most of a CrateStack response is decided by the `.cstack` schema: which fields exist, what
type each one has, and what a client is allowed to ask for. This guide ranks the levers by
what they measurably save, so you spend schema churn where it pays.

**The short version:**

1. Compress responses. On a list endpoint that alone removes 65–75 % of the bytes. On a
   single procedure call of a few hundred bytes it does nothing, or adds bytes: see
   [Single calls](#single-calls).
2. Let clients speak CBOR. It is already the default, except for the TypeScript REST client.
3. Ask for less: `?fields=`, `includeFields[path]`, `@@paged`, `@server_only`.
4. Then pick compact types. Model closed sets as `enum`, not `String`. Explicit
   [enum ordinals](#enum-ordinals) *(since 0.17.0)* store and send an enum as a small integer.
   They help most where nothing compresses the bytes.

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

### Single calls

Most procedure traffic is one object per request and one per response, a few hundred bytes each.
The framework measures three such bodies on every CI run and fails the build when one changes size:
`cratestack-api`'s `tests/payload_sizes.rs` encodes the generated request and response types through the real codecs and compares them with a
committed baseline *(Since 0.18.0, [cratestack#1281](https://github.com/cratestack/cratestack/pull/1281))*.
In bytes:

| Body | CBOR | CBOR + gzip | JSON | JSON + gzip |
|---|---|---|---|---|
| create a product, request | 212 | 214 | 274 | 236 |
| create a product, response | 312 | 279 | 404 | 298 |
| money transfer, request | 130 | 153 | 193 | 170 |
| money transfer, response | 242 | 257 | 346 | 263 |
| 500-row event list, response | 47 443 | 15 565 | 66 441 | 18 046 |

- **Gzip does not help a single call.** On three of the four single-call bodies the gzipped CBOR
  is *larger*: the gzip header and an empty dictionary cost more than a few hundred bytes of
  mostly unique values let it save. Compression pays off on lists, not on procedure calls.
- **CBOR is the lever that works at every size.** Uncompressed it is 23–33 % smaller than JSON on
  every row here. Gzipped, the gap narrows to 2–14 %.
- **The same numbers hold for the Dart and TypeScript RPC clients.** They encode through the same
  Rust `CborCodec` as the server (`cratestack_cbor`, `@cratestack/cbor`).

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
- **Dart client:** CBOR (`application/cbor`), through the native `cratestack_cbor`. See [Dart HTTP transport](./dart-http-transport).
- **TypeScript, `transport rpc`:** native CBOR through `@cratestack/cbor`. Passing
  `codec: jsonRpcCodec` puts JSON on the wire. The `--no-native-cbor` generator flag is removed
  *(Since 0.18.0, [cratestack#1281](https://github.com/cratestack/cratestack/pull/1281))*.
- **TypeScript, REST:** JSON only. The REST runtime has no codec seam
  ([TypeScript client generation](./typescript-client-generation#the-cbor-codec)). Compression
  is the lever for a REST browser client.

### CBOR nesting depth limit

*(Since 0.19.4, [cratestack#1315](https://github.com/cratestack/cratestack/issues/1315), a security fix.)* Before 0.19.4 the CBOR decoder recursed once per array, map or tag with no bound, so a body of about 8000 nested one-element arrays crashed the process with a stack overflow. Every CBOR decode now rejects input nested deeper than **128** levels. A level is an array, map or tag, definite or indefinite; a scalar is depth 0. Exactly 128 levels decode and 129 fail. The decode does not need a stack proportional to the input, and the codec stays usable after a refusal.

It applies to server request bodies, the Rust client, `@cratestack/cbor-node`, `@cratestack/cbor-web`, `@cratestack/cbor`, and Dart's native and web decode. The failure is a normal error: `CratestackError::Codec` with `nesting too deep (maximum depth is N)` in Rust, and a `RangeError` (with a `cause`) in JavaScript.

Where you can change it:

```rust
use cratestack_codec_cbor::{CborCodec, decode_with_max_depth, check_depth, DEFAULT_MAX_DECODE_DEPTH};

let codec = CborCodec::with_max_depth(64);          // CborCodecWithDepth: CratestackCodec
let value: MyType = decode_with_max_depth(bytes, 64)?;
check_depth(bytes, 64)?;                             // only count, do not decode
```

```ts
import { createCborCodec } from "@cratestack/cbor";

const codec = await createCborCodec({ maxDepth: 64 });   // async on web and the umbrella
// @cratestack/cbor-node: createCborCodec({ maxDepth }) is synchronous.
// A maxDepth that is not a non-negative integer throws RangeError.
// The raw decode(bytes, maxDepth?) takes the limit as a second argument.
```

Where you cannot:

- the Rust server and client `CodecSet` path, which always uses the default;
- the `application/cbor-seq` decoders;
- the outbox request-body decoder;
- Dart, where only the default applies.

::: warning
Raising the limit needs a stack to match. At 256, a debug-build decode into `serde_json::Value` overflowed a 1 MB thread stack. Keep the default unless you have input that genuinely nests deeper, and test the higher value on the smallest stack your threads use.
:::

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
| ordinal `enum` *(since 0.17.0)* | `SMALLINT` + membership `CHECK` | integer |
| `DateTime` | `TIMESTAMPTZ` (8 B) | text (RFC 3339) |
| `Uuid` | `UUID` (16 B) | 16 B binary on CBOR, text on JSON |
| `Decimal` | `NUMERIC` | text, deliberately ([scalars](../reference/scalars#serialization)) |
| `Int` | `BIGINT` | integer |
| `BigInt` *(since 0.15.4)* | `BIGINT` | text (a decimal string, [scalars](../reference/scalars#bigint)) |
| `Boolean` | `BOOLEAN` | boolean |

So in Postgres a `DateTime` is **not** stored as a string. It is an 8-byte `TIMESTAMPTZ`, and
it becomes a string only on the wire, on both codecs. The embedded SQLite backend is different:
every column is declared `BLOB`, and a `DateTime` is stored as RFC 3339 text
([offline-first SQLite](./offline-first-sqlite)), so there a timestamp really is a string at
rest.

### Closed sets: use an `enum`, not a `String`

A `status String` and a `status Status` cost the same bytes: both go out as text, until the enum
is made [ordinal](#enum-ordinals). Use the enum anyway, because the gains are correctness:

- The column gets a membership `CHECK`, so the database refuses a typo'd status.
- A filter like `?status=Pendng` is refused, and the error names the accepted values.
- Generated clients get a real type: a TypeScript string union, a Dart `enum`, a Rust `enum`.
- Policy literals (`auth().role == admin`) are checked against the variants at compile time.

It also puts the field in a position to move to [ordinals](#enum-ordinals) later without
touching application code. Good candidates: statuses, event kinds, roles, channels, categories.

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
names, not short ones. On a list, `?fields=` and compression handle the rest. On a single call
they do not, because there is nothing for gzip to find repeated
([Single calls](#single-calls)). That case is what the
[compact field keys](#compact-field-keys) are for. No attribute renames a field
on the wire only. `@rename(from = "…")` is a [migration marker](./migrations).

## Enum ordinals

::: info
**Since 0.17.0.** On 0.16.0 and earlier, `Pending = 1` is a parse error. The design and its measurements are in
[`docs/design/enum-ordinals.md`](https://github.com/cratestack/cratestack/blob/main/docs/design/enum-ordinals.md).
:::

Number every variant, and the enum is stored and sent as that number instead of its name:

```cstack
enum PaymentStatus {
  Pending = 1
  Approved = 2
  Rejected = 3
  Refunded = 5

  @@reserved(4)   // was Settled; never reuse
}
```

| Where | String enum | Ordinal enum |
|---|---|---|
| Postgres column | `TEXT` + `CHECK (status IN ('Pending', …))` | `SMALLINT` (2 B) + `CHECK (status IN (1, 2, 3, 5))` |
| SQLite | the name | the integer |
| CBOR or JSON body, REST and RPC | the name (`Pending`: 8 B CBOR) | the number (1 B) |
| `@default(Pending)` | `DEFAULT 'Pending'` | `DEFAULT 1` |
| Query string | `?status=Approved` | `?status=Approved`; `?status=2` is refused |
| Policy | `status != Refunded` | `status != Refunded`, compared as a number |

Application code keeps using names:

- **Rust:** the same enum, now `#[repr(i16)]`, with `ordinal()` and `TryFrom<i16>`; `Display` and
  `FromStr` still use names.
- **TypeScript:** the type stays `'Pending' | 'Approved' | …`. Responses are revived from numbers
  to names. Requests still send names, so a TypeScript client does not save bytes on what it sends.
- **Dart:** the same constants, with `int wireValue` beside `wireName`.
- **Studio** shows `Approved (2)`. **WireMock** stubs carry numbers. An MCP tool's input schema
  lists each number with its variant's name as the title.

A server decodes a body's ordinal enum from the number **or** the name, so a client still sending
names keeps working. It always answers with the number.

### Why the mapping must be explicit and enforced

The tempting shortcut is to use each variant's position in the declaration. That breaks
silently the first time someone sorts the variants or inserts one in the middle: every stored
row now means a different status, and nothing errors. So the mapping is explicit and
**append-only**:

- Every variant has a number, or none does. Numbers are unique, from 0 to 32767.
- `cratestack migrate diff` refuses to change a variant's number, to remove a variant without
  listing its number in `@@reserved`, to drop a number from `@@reserved`, and to reuse a reserved
  number.
- Renaming a variant while keeping its number is allowed and moves no data.
- Removing a variant, here or from a string enum, is a **blocking** migration: rows may still
  hold the value, so `up.pre.sql` is scaffolded with
  `UPDATE … SET status = <a value the enum keeps> WHERE status IN (5)` to adapt *(since 0.17.0)*.
- `cratestack diff` reports removed and added variants, for every enum
  ([schema diff](../tooling/schema-diff)).
- An `auth` field may not have an ordinal enum type: a claim's encoding is the auth provider's
  choice, and a policy comparing it with a number could fail open.

### "We don't need readable values in the database any more"

The argument for ordinals is that the schema is the decoder: anyone with the `.cstack` file, an
AI assistant included, can read `status = 3` as `Rejected`. That is true where the schema
travels with the data:

- Generated clients and Studio show names.
- `psql`, BI tools, a backup restored years later, and audit or outbox payloads show integers.

So use ordinals where values are high-volume, stable and machine-read: event kinds, statuses on
hot tables, anything streamed. Keep names for small tables and anything an on-call engineer or
auditor reads raw.

### Converting an existing enum

Add the numbers to the enum and run `cratestack migrate diff`. It writes the data migration:

- **Postgres:** the column changes type with `USING (CASE status WHEN 'Pending' THEN 1 … END)`,
  and its default and `CHECK` follow. It is classified lossy (it rewrites the table under an
  exclusive lock), so `migrate diff` writes it only with `--allow-destructive`.
- **SQLite:** `UPDATE … SET status = CASE status WHEN 'Pending' THEN 1 … END`.

Removing the numbers converts back the same way. That is why closed sets should be an `enum`
now: converting an enum is one schema edit, converting a `String` column is a redesign.

On the wire the conversion is a breaking change. Regenerate the clients and deploy them with the
server. Clients you cannot update in lockstep, such as installed mobile apps, are the hard case:
a procedure can serve the new shape beside the old one under
[`@api_version`](../architecture/http-transport-contract#procedure-routes), but model routes are
not versioned, so an enum those apps read through a model can only become ordinal once they have
updated.

### Limits

- Sorting by an ordinal enum (`?sort=status`) orders by number.
- `cratestack migrate` reading a live Postgres reports drift on an ordinal column, because it
  does not map `SMALLINT` or parse the numeric `CHECK`.

## Compact field keys

*(Since 0.18.0.)* On a single call, field names are a third to almost half of a body, and gzip
cannot remove them (see [Single calls](#single-calls)). With compact keys, each schema field
travels as a small integer key instead, when client and server share the schema. The
framework's payload gate measures this on every CI run:

| Body | CBOR | compact CBOR | JSON | compact JSON |
|---|---|---|---|---|
| create a product, request | 212 | 135 | 274 | 207 |
| create a product, response | 312 | 213 | 404 | 321 |
| money transfer, request | 130 | 67 | 193 | 136 |
| money transfer, response | 242 | 132 | 346 | 248 |
| 500-row event list, response | 47 443 | 31 443 | 66 441 | 52 941 |

### How it works

- **Opt-in, per client.** A client that enables it asks for
  `application/vnd.cratestack.compact+cbor` (`+json`, and `+cbor-seq` for streams), and names
  its version of the operation in the `Cratestack-Contract` header. A client that does not
  enable it sends and receives exactly what it did before.
- **The server needs nothing.** The generated router answers compact when it knows the client's
  version of the operation, and answers with names otherwise. With a
  [contract lock](./signed-transport) (`contracts =`), a newer server keeps answering older
  clients compactly, each with its own numbering.
- **No schema change.** Keys come from the operation's contract: fields in contract order,
  procedure arguments in declaration order. You write no field numbers.
- **Requests follow responses.** A client sends an operation's request body compact only after
  that operation answered compact once. A server without the mode never receives a body it
  cannot read.
- **What stays named:** `/rpc/batch` frames, error bodies, the `Page` wrapper's own keys, query
  strings, and outbox and audit payloads.
- **One implementation.** The remapping is Rust code in the codec crates. The Dart and
  TypeScript clients reach it through `cratestack_cbor` and `@cratestack/cbor`
  (`createCompactKeys`).

### Durable retries and negotiation

*(Unreleased, [cratestack#1297](https://github.com/cratestack/cratestack/pull/1297).)* Compact negotiation can change between attempts. A prepared unary mutation freezes the original named or compact inner bytes and media type before the first send; persist that snapshot before executing it. Restoring with mismatched tables or contract is refused rather than re-encoding the payload. See [idempotency](./idempotency#preserve-a-request-before-the-first-attempt).

### Turning it on

Rust, on the generated client:

```rust
let client = Client::with_compact_keys(runtime);
```

TypeScript, on the RPC or REST client options. A REST client also needs `@cratestack/cbor`
installed, as an optional peer dependency:

```ts
const client = new ShopClient("https://api.example.com", { compactKeys: true });
```

The client detects `createCompactKeys` on `@cratestack/cbor` and stays named on a version that
lacks it.

Dart, by wiring the generated hooks to `cratestack_cbor` (CBOR format only):

```dart
final keys = await createCompactKeys(cratestackKeyTables);
final adapter = CratestackHttpAdapter(
  transport,
  compact: CratestackCompactHooks(
    toCompact: keys.toCompact,
    fromCompact: keys.fromCompact,
    selector: keys.selector,
  ),
);
```

With [signed transport](./signed-transport), a sealed body carries compact keys too: the
compact type is the inner payload type, bound in the signature. Add the compact types to the
envelope layer's `payload_media_types`, for requests and responses together:

```rust
const COMPACT_CBOR: &str = "application/vnd.cratestack.compact+cbor";

let layer = cratestack_schema::axum::envelope_layer(envelope, EnvelopeMode::Required, "payments")
    .payload_media_types(["application/cbor", COMPACT_CBOR], ["application/cbor", COMPACT_CBOR])
    .build()?;
```

A Rust client with both `with_envelope` and `with_compact_keys` then negotiates exactly as an
unsealed one does. Dart and web apps that seal their own calls pass the compact type on the
`CallBinding`; see [the Dart client](./signed-transport#the-dart-client). Signed streams stay
plain, because `+cbor-seq` is never sealable.

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
