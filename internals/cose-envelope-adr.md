---
title: "ADR 0006: COSE Envelope Modes and Key Management"
description: A signing envelope over the existing CBOR codec — COSE_Mac0, COSE_Sign1, and checkpoint-chained cbor-seq streams — bound to the request through external AAD, with offline-aware replay protection. Proposed; decisions open.
---

# ADR 0006: COSE Envelope Modes and Key Management

## Status

**Proposed** — 2026-09-24. Nothing here is implemented in `cratestack` yet. A proof of concept
exists outside this repository (maintainer, 2026-09-24). The design and the measurements below
come from that work. **Ten choices are the maintainer's to make** and are listed first. None is
decided by this document, although each carries a recommendation.

This fills the slot [ADR 0001](./core-architecture-adr) reserved as "ADR 0006: COSE Envelope Modes
and Key Management". It keeps 0001's envelope principle ("COSE is not a codec. COSE wraps encoded
bytes") and its processing order (`HTTP body → envelope.open → codec.decode`).

## Date

2026-09-24 (proposed)

## Decisions for the maintainer

Fill in the **Decision** column. The implementing epic's tickets are blocked on the rows they
cite.

| # | Question | Recommendation | Decision |
|---|---|---|---|
| D1 | Shape: a signing **envelope** over `CborCodec`, or a sibling `CratestackCodec`? | Envelope. The codec trait has no key, no request context and no `async`, and signing needs all three (§1). | _open_ |
| D2 | Wire modes: `mac0`, `sign1`, and `chain` for streams? | All three. `chain` is what makes signed streaming affordable (§6). | _open_ |
| D3 | Replay model for device keys: a per-device counter with a sliding window, replacing timestamp skew plus a nonce store? | Yes. The current 300 s skew window rejects any mutation that sat in an offline queue longer than that (§5). | _open_ |
| D4 | Schema-bound integer keys: a separate packed codec, shipped later? | Yes, a separate ticket (§9). | _open_ |
| D5 | Register CBOR tags 48900 (existing error sentinel) and 48901 (checkpoint) with IANA (First Come First Served)? | Yes, before 1.0. | _open_ |
| Q1 | Sign unary **GET responses** by default in `Required` mode (+85 B each), or only mutations and streams? | — | _open_ |
| Q2 | Default **server** key algorithm: EdDSA or ES256? Cloud HSMs and KMSs support P-256 more widely. | — | _open_ |
| Q3 | Checkpoint cadence per op or global? Is 64 items / 32 KiB / 2 s right for 2G links? | — | _open_ |
| Q4 | Counter atomicity: `JsonFileStateStore` writes with a plain `std::fs::write` (`cratestack-core/src/store/client_state.rs`), which is not crash-atomic. Should `window` mode require the SQLite store, or should the JSON store move to write-temp-then-rename first? | — | _open_ |
| Q5 | Post-quantum: accept that algorithm agility plus chain mode is the migration path (ML-DSA-44 signatures are about 2.4 KB)? | — | _open_ |

A decision that changes a public trait (D1, the async `CratestackEnvelope` below) is breaking. That
is acceptable before 1.0, and today only `NoEnvelope` implements it.

## Context

### What exists today

Verified against `cratestack` `main` on 2026-09-24.

| Piece | Where | Relevance |
|---|---|---|
| `CratestackCodec`: sync `encode`/`decode`, no context | `cratestack-core/src/codec.rs` | Cannot sign: no key, no request, no async |
| `CratestackEnvelope`: `open_request`/`seal_response` over bytes, sync | same file | The right seam, but only `NoEnvelope` implements it and **no router calls it** |
| `HmacEnvelope` + `SealedEnvelope` (HS256) | `cratestack-core/src/envelope.rs` | A separate async API that does not implement the trait |
| Ed25519 `Authorization: Signature …` with `contentSha256` | `cratestack-auth/src/signed_request/` | `DeviceKeyResolver`, `NonceStore`, skew window |
| COSE_Sign1 via `coset` (EdDSA, kid) for enrolment | `cratestack-auth/src/cose_enroll.rs` | The only `coset` user |
| `application/cbor-seq` for `@stream`, error sentinel `Tag(48900, RpcErrorBody)` | `cratestack-axum/src/transport/stream_sequence.rs`, `RPC_STREAM_ERROR_TAG` in `cratestack-core/src/rpc.rs` | The streaming path to extend |
| `CborSeqChunkDecoder` | `cratestack-client-rust/src/streaming.rs` | Boundary scanner that learns one more tag |
| `RuntimeEnvelopeConfig::CoseSign1` | `cratestack-client-rust/src/runtime/handle.rs`, mirrored in `cratestack-client-flutter` | A placeholder, rejected at runtime: *"COSE envelope support is not implemented yet"* |
| `x-cratestack-schema-sha` | `cratestack-client-rust/src/client/headers.rs` | Goes into the AAD |
| Rust-backed CBOR for JS (`cratestack-cbor-wasm`, `-napi`), FRB for Flutter | `crates/` | One Rust COSE implementation can serve every client |

Two defects in today's `HmacEnvelope`, independent of this proposal:

- **It signs a different serialization than it sends.** The MAC covers `serde_json::to_vec(&body)`,
  while the envelope travels as CBOR. Verification works only because both sides re-serialize a
  `serde_json::Value` identically. Any value that JSON represents lossily (bytes, big integers, CBOR
  tags, float edge cases) breaks that silently. COSE removes the issue: the payload is a byte string,
  and the verifier checks the bytes it received.
- **It spends bytes badly:** 147 B per message, against 41 B for the COSE_Mac0 equivalent.

### Codec parity today

The goal is that every client and server surface can speak `application/cbor`,
`application/cbor-seq` and the COSE media types.

| Surface | CBOR | cbor-seq | COSE |
|---|---|---|---|
| Server, RPC | yes | `@stream` responses | — |
| Server, REST | yes | list-returning procedures | — |
| Rust client, RPC | yes | yes | placeholder, rejected |
| Rust client, REST (generated) | yes | the runtime has `post_list_streamed`; codegen never calls it | — |
| TypeScript client, RPC | yes (`@cratestack/cbor`) | yes | — |
| TypeScript client, REST | **no**: `Accept: application/json` is hardcoded | **no** | — |
| Dart client, RPC / Flutter | yes (FRB) | yes | placeholder, rejected |
| Dart client, REST | yes | **no** | — |
| Upload direction | — | nowhere: `/rpc/batch` is one CBOR array | — |
| Subscriptions | — | SSE (text) only | — |

cbor-seq parity is tracked separately from COSE because it needs no decision from this ADR. It is a
prerequisite for §6 and §7 on every surface.

### Measurements

These numbers come from the proof of concept (`coset 0.4.2`, `ed25519-dalek`, `hmac`/`sha2`,
`minicbor-serde` configured like `CborCodec`). The fixture is a 7-field payment row: 112 B as CBOR
with string keys. The bench script is not yet in this repository; bringing it in is part of P0's
shared test vectors.

**Unary, one row:**

| Wire shape | Bytes | Overhead |
|---|---:|---:|
| Plain `application/cbor` | 112 | — |
| `HmacEnvelope` today | 259 | +147 (+131%) |
| Ed25519 `Authorization: Signature` today | 112 + 304 header | +304 |
| **COSE_Mac0 HMAC 256/64**, kid(8), `{iat, cti}` | 153 | **+41 (+37%)** |
| COSE_Mac0 HMAC 256/256, kid(8), `{iat, cti}` | 178 | +66 |
| **COSE_Sign1 EdDSA**, kid(8), `{iat, cti}` (request) | 210 | **+98 (+88%)** |
| COSE_Sign1 EdDSA, kid(8) only (response) | 197 | +85 |

Signature headers are unique per request, so HTTP/2 HPACK cannot compress them, and clients rarely
compress request bodies. **Raw size is the uplink cost**, and on the target links the uplink is
usually the scarcer direction.

**Streams, 1 000 rows:**

| Mode | Raw | zstd-3 | vs plain (zstd) |
|---|---:|---:|---:|
| Plain `application/cbor-seq` | 112 371 | 21 919 | — |
| Per-item COSE_Sign1 | 203 115 | 93 100 | **×4.25** |
| Per-item COSE_Mac0 HMAC 256/64 | 146 115 | 35 317 | ×1.61 |
| Chain, Sign1 checkpoint every 16 | 120 294 | 29 207 | +33% |
| **Chain, Sign1 checkpoint every 64** | 114 385 | 23 795 | **+8.6%** |
| Chain, Sign1 checkpoint every 256 | 112 876 | 22 396 | +2.2% |

Ed25519 signatures are 64 bytes of incompressible noise. Signing every item costs +81% raw but ×4.25
after compression, because the signatures break the redundancy compressors exploit. Chained
checkpoints keep a compressed stream within a few percent of unsigned.

**Integer keys (§9), same rows, unsigned:** 112 → 57 B per row raw (−49%); zstd total 21 919 →
18 471 (−16%).

## Goals and non-goals

**Goals**

- End-to-end integrity and origin authentication of payloads. They must survive TLS-terminating hops
  (CDNs, load balancers, operator and corporate proxies), storage in the offline SQLite store, and
  relay between devices.
- Low byte overhead, especially on the uplink and on streams.
- Streaming as a first-class case: incremental verification, detectable truncation, and resumption
  (P3).
- Offline-first: a mutation signed when it was created stays valid for upload days later, without
  opening a replay hole.
- **Auth headers become optional for signed traffic.** A verified COSE key identifies the caller, so
  writes do not also need `Authorization: Signature` (§12).
- No canonicalization anywhere. Verify the exact bytes that were sent.
- One Rust implementation shared by the Rust, JS (wasm/napi) and Flutter (FRB) clients.

**Non-goals (v1)**

- Confidentiality. TLS covers transit; COSE_Encrypt0 for data at rest can come later on the same
  structure.
- Multi-signer COSE_Sign, or COSE_Mac with recipients.
- Replacing TLS or the enrolment protocol.

## Decision (proposed)

### 1. Layering: the codec stays simple, the envelope binds

```
typed value ──CborCodec──▶ payload bytes ──CoseEnvelope──▶ COSE_Sign1 / COSE_Mac0 / chain
                               ▲                              │
                               └──────── verified as-is ◀─────┘
```

The payload `bstr` **is** the codec output, byte for byte. The sealer encodes straight into the COSE
buffer: it reserves up to 9 bytes for the `bstr` head, encodes, then patches the head. The verifier
checks those bytes and hands the same slice to `CborCodec::decode`. Nothing is re-serialized.

The envelope is not a new `CratestackCodec` implementation. Signing needs a key, request context
(route, method, request digest) and `async` (so KMS and HSM backends can plug in). Adding those to the
codec trait would touch every `C: CratestackCodec` bound across the server and all clients. The
envelope seam already exists and only needs to become real:

```rust
/// Replaces the current sync, bytes-only trait (only `NoEnvelope` implements it today).
pub trait CratestackEnvelope: Clone + Send + Sync + 'static {
    fn media_type(&self, shape: BodyShape) -> &'static str;

    fn seal<'a>(&'a self, payload: Bytes, bind: &'a Binding<'a>)
        -> BoxFuture<'a, Result<Bytes, CratestackError>>;

    /// Verifies, runs replay checks, records the principal (kid → device/service)
    /// in ctx, and returns the payload slice (zero-copy into `body`).
    fn open<'a>(&'a self, body: Bytes, bind: &'a Binding<'a>, ctx: &'a mut CratestackContext)
        -> BoxFuture<'a, Result<Bytes, CratestackError>>;

    /// `None` = this envelope does not sign streams (plain cbor-seq passes through).
    fn stream_sealer(&self, bind: Binding<'static>) -> Option<Box<dyn StreamSealer>>;
    fn stream_opener(&self, bind: Binding<'static>) -> Option<Box<dyn StreamOpener>>;
}

/// Everything that goes into external_aad. Built by router/client, never sent (§4).
pub struct Binding<'a> {
    pub method: &'a str,
    pub route: &'a str,                    // op_id for RPC; route template + params for REST
    pub query: Option<&'a str>,            // canonical_query()
    pub schema_sha: &'a [u8; 32],
    pub payload_media_type: &'a str,       // "application/cbor"
    pub request_digest: Option<[u8; 32]>,  // responses only
    pub status: Option<u16>,               // responses only
}
```

**Keys are signed with, not exported.** `KeyProvider::resolve_signing_key` returns raw key bytes.
That fits HMAC, but not asymmetric keys held in an HSM or KMS. Add:

```rust
#[async_trait]
pub trait CoseSigner: Send + Sync + 'static {
    fn alg(&self) -> coset::iana::Algorithm;
    fn kid(&self) -> &[u8];                  // 8-byte thumbprint prefix, §3
    async fn sign(&self, to_be_signed: &[u8]) -> Result<Vec<u8>, CratestackError>;
}

#[async_trait]
pub trait CoseVerifierResolver: Send + Sync + 'static {
    /// May return several candidates on kid-prefix collision; the opener tries each.
    async fn resolve(&self, kid: &[u8], alg: coset::iana::Algorithm)
        -> Result<Vec<VerifyingKey>, CratestackError>;
}
```

Adapters: `KeyProvider` → Mac0 keys, `DeviceKeyResolver` → device Ed25519 keys, and
`ServiceSigningKey` → a `CoseSigner`.

### 2. Media types

| Body | Media type | Basis |
|---|---|---|
| Unary signed | `application/cose; cose-type="cose-sign1"` | RFC 9052 §2 |
| Unary MAC'd | `application/cose; cose-type="cose-mac0"` | RFC 9052 §2 |
| Signed stream (chain or per-item) | `application/vnd.cratestack.cose-seq+cbor-seq` | RFC 8742 `+cbor-seq` suffix |

The inner payload media type is not sent in a COSE header (label 3 would cost bytes on every message).
It is bound through the AAD instead (§4), so a verifier cannot be tricked into decoding the payload as
something else.

Negotiation uses the existing `Accept` and `Content-Type` headers. The router gains a policy:
`Required` (unsigned requests → `401 unauthenticated`), `Optional` (verify when present), or `Off`.

### 3. Message layout

```cddl
; Unary: COSE_Sign1 = tag 18, COSE_Mac0 = tag 17 (always tagged on the wire)
protected = {
  1 => int,                ; alg: -8 EdDSA (default), -7 ES256; Mac0: 4 = HMAC 256/64, 5 = HMAC 256/256
  4 => bstr .size 8,       ; kid: first 8 bytes of the RFC 9679 COSE Key Thumbprint
  ? 15 => {                ; CWT Claims (RFC 9597), requests only
    ? 6 => int,            ;   iat, seconds
    ? 7 => bstr,           ;   cti: device counter (1–4 bytes) or 16 random bytes, §5
  }
}
unprotected = {}           ; always empty: nothing unauthenticated on the wire
payload     = bstr .cbor Body
```

- **kid = an 8-byte thumbprint prefix.** It is derived from the key, so no kid strings are stored,
  and rotation is self-describing. The birthday bound is about 2³² keys, and the resolver returns
  several candidates on the rare collision.
- **Algorithms by direction.**
  - Device → server: **EdDSA**. Device keys are already Ed25519, and these messages must be provable
    later.
  - Server → client: **EdDSA** by default, or **ES256** where the key lives in an HSM or as
    non-extractable WebCrypto (Q2).
  - Service → service inside one trust domain: **Mac0 HMAC 256/256**, or HMAC 256/64 on constrained
    links. A 64-bit tag is safe only because forgery requires online attempts, and those are rate
    limited.
- **Why not Mac0 for devices?** It is cheaper (41 B against 98 B), but with a symmetric key the server
  could forge device messages, so non-repudiation is lost.

### 4. External AAD: binding without bytes on the wire

```cddl
external_aad = bstr .cbor [
  1,                        ; binding version
  method: tstr,
  route: tstr,              ; RPC op_id (stable across prefix rewrites); REST route template
  query: tstr / null,       ; canonical_query()
  schema_sha: bstr .size 32,
  payload_type: tstr,       ; "application/cbor"
  ? request_digest: bstr .size 32,  ; responses: SHA-256 over the request's COSE bytes (or payload if unsigned)
  ? status: uint,                   ; responses
]
```

Both sides rebuild this from context they already have, so it **costs 0 bytes on the wire**. It
defeats:

- **cross-endpoint replay:** a body signed for `payment.create` fails on `payment.refund`;
- **response swapping:** a response is bound to its request and its status code;
- **schema drift:** a client built against another `.cstack` fails closed.

Use the `op_id`, never the raw URL path, because gateways rewrite prefixes. (The same fact made
`Router::nest` break descriptor lookup in cratestack#877.)

### 5. Freshness and replay, offline-aware

Both `HmacEnvelope` (`ENVELOPE_DEFAULT_CLOCK_SKEW_SECS = 300`) and the signed-request verifier gate
freshness on a clock-skew window. A mutation signed in a dead zone and uploaded three hours later is
rejected. Signing at upload time instead loses when and where the data was created.

| Mode | cti | Server state | For |
|---|---|---|---|
| `window` | per-kid monotonic counter, minimal big-endian (1–4 B) | per kid: highest counter plus a 64-bit (configurable 256) bitmap | device keys |
| `nonce` | 16 random bytes | existing `NonceStore`, expiring with the skew window | shared/service keys, multi-replica senders |

`window` is the anti-replay window of IPsec (RFC 4303 §3.4.3) and OSCORE (RFC 8613 §7.4):

- No time limit on validity: a request signed days ago is accepted if its counter is new.
- Out-of-order delivery within the window is tolerated, which covers parallel batch uploads.
- Server state is O(1) per device.
- `iat` is still signed, for audit and for an optional per-op policy such as
  `@signed(max_age: "30d")`.
- **The device persists the counter in the same write as the queued mutation.** A reused counter
  reads as a replay (Q4). Reinstalling the app re-enrols with a fresh key.
- Multi-replica servers keep the per-kid window in Redis or PG with compare-and-set, using the
  backends the idempotency and rate-limit stores already use.

**Retry is not replay.** Derive the idempotency key from `(kid, cti)` when no `Idempotency-Key`
header is present. The first delivery executes. A byte-identical resend within the idempotency TTL
gets the stored response. A resend after the TTL is rejected by the window. The handler never runs
twice.

### 6. Streams: `chain` mode

Items stay **bare CBOR**, as in today's `application/cbor-seq`. The server keeps a running hash and
periodically emits a signed checkpoint:

```
h₀ = SHA-256(external_aad)                      ; binds the chain to this request, 0 bytes sent
hᵢ = SHA-256(hᵢ₋₁ ‖ itemᵢ_bytes)

checkpoint = #6.48901(COSE_Sign1)               ; payload:
  [ seq: uint, h_seq: bstr .size 32, ? resume: bstr, ? end: true / RpcErrorBody ]
```

- **Cadence:** every 64 items, 32 KiB or 2 s, whichever comes first (Q3). Ops can override with
  `@stream(checkpoint: 16|64|256)`.
- **The terminal checkpoint is mandatory.** It carries `end: true`, or the `RpcErrorBody` on
  failure. In signed mode it **replaces** the unsigned `Tag(48900, …)` sentinel, so a forged error is
  detectable too.
- **Truncation is detectable.** A body that ends without a terminal checkpoint is `Incomplete`.
  Today a stream cut short by a middlebox that closes cleanly looks like a short, successful stream.
- **Reordering, dropping or injecting items** breaks `h` at the next checkpoint.
- **Detection:** `RPC_STREAM_ERROR_TAG` gets a sibling `RPC_STREAM_CHECKPOINT_TAG = 48901`. The Rust
  `CborSeqChunkDecoder` and the TS scanner (`packages/cratestack-ts-types/src/cbor-seq.ts`) classify
  the leading tag. The tag wrapper keeps a checkpoint distinct from a legitimate item that is itself a
  COSE_Sign1.

**Client consumption modes:**

- `Verified` buffers items until their checkpoint verifies. Added latency is at most one checkpoint
  interval, and memory is at most N items.
- `Optimistic` releases items at once and raises a tamper error at the checkpoint. This fits the
  offline store: a SQLite transaction per checkpoint window, committed when it verifies and rolled
  back when it doesn't.

**Per-item mode** (each item its own COSE_Sign1 with `cti = seq`) is opt-in per op, for items that
must be verifiable on their own later.

**Resumable streams (P3):** a checkpoint may carry `resume`, an opaque server cursor. Because the
checkpoint is server-signed, the server can accept it back **statelessly**. The client sends
`Cratestack-Resume: <base64url of the last verified checkpoint>`, and the server verifies its own
signature and continues the chain from `h_seq`. A sync that dies at 80% resumes at 80%. This works
only for producers that can restart from a cursor (keyset-paginated reads), marked
`@stream(resumable)`.

**Subscriptions:** SSE is text, so binary COSE would need base64 (+33%). Signed subscriptions get a
`GET` cbor-seq binding in chain mode with a time-based cadence, rather than signing over SSE.

### 7. Uploads: signing the offline queue

1. When a mutation is created offline, the Rust runtime wraps it as a COSE_Sign1 `RpcRequest` frame
   with `cti = next counter` and persists **those exact bytes**. The queue is tamper-evident at rest,
   and `iat` records the device clock at creation.
2. On connectivity, the client flushes with `POST /rpc/batch` and
   `Content-Type: application/vnd.cratestack.cose-seq+cbor-seq`. Each frame is independently signed.
3. The server verifies each frame on its own. Results return as a chain-signed cbor-seq keyed by
   `cti`, so a partial failure fails only its frames.
4. After a dropped connection the client resends the unacknowledged frames. Anything already applied
   hits the §5 idempotency path.

`BATCH_MAX_ITEMS` (1 000) and `DEFAULT_BODY_LIMIT_BYTES` (2 MiB) apply unchanged. The client splits
large queues into several batches.

### 8. Key distribution

- **Server signing keys** are published as a COSE_KeySet at `/.well-known/cratestack/cose-keys`, next
  to the existing `jwks_router`. The client **pins at enrolment**: the enrolment response is already
  a COSE_Sign1 (`cose_enroll.rs`) and gains the response-signing key thumbprint(s).
- **Device keys** use the existing `DeviceKeyResolver`, indexed additionally by thumbprint prefix.
- **Rotation:** the keyset holds old and new keys, and the kid selects between them.

### 9. Schema-bound integer keys (separate codec, P3)

The payload saving (−49% raw, −16% compressed) is larger than anything signing costs, and it helps
unsigned traffic too. It is orthogonal to COSE and ships as `CborPackedCodec` (D4). It needs stable
field ids, via explicit `@wire(n)` or ids locked in a committed lockfile, with renumbering a schema
error. The schema SHA in the AAD makes a mismatch fail closed when signed; unsigned, the existing
`x-cratestack-schema-sha` check is the guard.

### 10. Errors and threat model

- **Verification failures** return `401` with `RpcErrorBody{code: "unauthenticated"}` and a coarse
  reason. The response must never reveal which check failed.
- **Error responses are signed too**, or a hop could inject fake errors.
- **A client in `Required` mode rejects unsigned or wrongly signed responses.** It never falls back
  to plain.
- **Why sign over TLS at all:** TLS ends at the first terminating hop. Signed data stays verifiable at
  rest and when relayed between devices. Financial audit needs non-repudiation. Signed responses can
  be cached by untrusted edges.
- **Existing mechanisms:**
  - `HmacEnvelope` becomes Mac0 mode: deprecated for one minor release, then removed.
  - `Authorization: Signature` stays for bodiless requests (GET). For writes in signed mode, COSE
    subsumes it (method and route are in the AAD) and saves about 300 B of headers.
  - The 48900 sentinel is unchanged in unsigned mode.
  - The idempotency stream bypass still applies to signed streams.

### 11. One implementation, every client

One Rust crate, `cratestack-cose`, wraps `coset`; `cose_enroll.rs` moves into it. It is consumed by:

- `cratestack-client-rust` (native, plus the Flutter runtime via FRB), which lifts the
  "not implemented" guard;
- `cratestack-cbor-wasm` and `-napi`, which gain `seal`, `open` and a chunk-fed `StreamOpener`. The
  React Native story in cratestack#893 plans a Rust-backed codec on device and inherits this.

Cross-language signature bugs almost always come from two implementations disagreeing on bytes. There
is no second implementation in TS or Dart. The TS cbor-seq scanner stays for framing, but chain
verification (hashing, signature checks) goes through the wasm/napi exports. Generated Dart clients
that bypass the Rust runtime require the runtime for signed mode until there is demand.

### 12. Placement relative to the existing layers

This section was added while reviewing the proposal against the codebase. It is what "auth headers
become optional" requires.

- **The envelope must run before rate limiting and idempotency.** Both layers derive their caller key
  from the `Authorization` header by default: they hash it, fall back to the `ConnectInfo` peer, and
  refuse with `412` when neither exists (`cratestack-axum/src/{ratelimit/key_fn.rs,idempotency/}`). A
  COSE-only client sends no `Authorization` header, so it would be bucketed by IP address or refused.
  The envelope's `open` therefore runs first and inserts the verified kid as a `VerifiedPrincipal`
  request extension. Rate limiting already treats that as a non-caller-mintable `princ:` bucket that
  needs no cardinality budget (cratestack#871), which closes the "unverified header mints buckets"
  class for signed traffic. The idempotency principal fingerprint needs the same hook. This is **P0**,
  not a later phase: without it, the P0 wiring breaks existing throttling and replay behaviour for
  COSE clients.
- **The `(kid, cti)` idempotency key belongs in the L3 `OpExecutor`** (ADR 0015). Its input is not an
  HTTP request, which is exactly the property that motivated building L3. Idempotency admission
  (slice 1) and rate-limit admission (slice 2, cratestack#877) already decide there. The in-process
  path from ADR 0018 then gets the same replay semantics without a second implementation.

## Consequences

**Positive**

- One signing mechanism replaces `HmacEnvelope` and, for writes, `Authorization: Signature`, at a
  quarter to a third of their byte cost.
- Signed streams cost single-digit percent over unsigned, and truncation becomes detectable, which it
  is not today.
- Offline mutations stay valid for upload indefinitely without a replay hole.

**Negative**

- Breaking change to `CratestackEnvelope`, and to `RuntimeEnvelopeConfig` consumers once the
  placeholder becomes real.
- New server state per device key (the window), with compare-and-set on multi-replica deployments.
- Clients that bypass the Rust runtime cannot use signed mode.

## Alternatives considered

- **COSE as a `CratestackCodec` implementation.** Rejected (§1): no key, no request context, no
  `async`, and it would touch every codec bound in the workspace.
- **Per-item signing as the stream default.** Rejected on the measurements: ×4.25 after compression.
  It remains available per op.
- **Timestamp skew plus a nonce store for device keys.** Rejected for devices (§5): it cannot accept
  an offline mutation older than the skew window. It stays the mode for service keys.
- **Mac0 for device traffic.** Rejected (§3): a symmetric key lets the server forge device messages.

## Phasing

| Phase | Scope |
|---|---|
| **P0** | Accept this ADR. Async `CratestackEnvelope` + `Binding`. `cratestack-cose` with unary Mac0/Sign1, AAD, `nonce` replay. Axum + Rust client wiring behind `Required`/`Optional`, **including the §12 principal handoff**. Shared test vectors (fixed keys, deterministic Ed25519) checked in. |
| **P1** | `chain` streams for `@stream`. Decoders learn tag 48901. `Verified`/`Optimistic` consumption. wasm/napi exports. Flutter guard lifted. COSE_KeySet endpoint and enrolment pinning. IANA registration of 48900/48901. |
| **P2** | `window` replay for device keys. Signed offline queue. Signed `/rpc/batch` upload. Idempotency key derived from `(kid, cti)` at L3. `HmacEnvelope` deprecation. |
| **P3** | Resumable streams (`@stream(resumable)`). Signed subscription binding. `CborPackedCodec` (separate ticket). |

## Test plan (acceptance)

- **Vectors:** identical bytes from Rust native, wasm and napi for the same key and payload.
  Deterministic Ed25519 makes this exact.
- **Tampering:** flip one bit in each of the payload, the protected header, the AAD route, the AAD
  schema SHA and the request digest → reject. Assert on encoded bytes, not decoded values.
- **Streams:** truncate before the terminal checkpoint → `Incomplete`. Reorder, drop or insert an
  item → reject at the next checkpoint. A forged error item → reject. A legitimate COSE_Sign1 item →
  not treated as a checkpoint.
- **Replay:** resend the same bytes → idempotent response, handler not re-run. Counter below the
  window → reject. Out of order within the window → accept. Counter reuse → reject.
- **Offline:** mutation signed at T, uploaded at T+72 h → accepted in `window` mode, rejected in
  `nonce` mode.
- **Layer placement (§12):** a COSE-only request with no `Authorization` header and no `ConnectInfo`
  → not refused with `412`, and charged to its `princ:` bucket.
- **Fuzzing:** `CborSeqChunkDecoder` over arbitrary bytes containing tags 18, 48900 and 48901.
