---
title: "ADR 0020: Offline Sync Engine"
description: Server-authoritative mutation replay between include_embedded_schema! devices and an include_server_schema! Postgres server, with a trigger-captured, commit-ordered change log, a client-side undo log, TTLs and protection limits. Proposed, with a working prototype.
---

# ADR 0020: Offline Sync Engine

## Status

**Proposed**, 2026-10-22. A working prototype backs it: the `cratestack-sync` crate (`publish = false`)
and the `examples/sync-notes` demo, in the framework PR linked from this ADR's pull request. The full
design, including what the prototype measured, is
[`docs/design/sync-engine.md`](https://github.com/cratestack/cratestack/blob/main/docs/design/sync-engine.md)
in the framework repository. Nothing here is a supported surface until this ADR is accepted.

The number is the next free one across both repositories. 0007–0010 are reserved by ADR 0001, and
0011–0019 are the framework's internal-shape series. This ADR lives here rather than in the framework
because it fixes a user-visible protocol and proposes schema grammar.

## Date

- 2026-10-22: proposed, with prototype

## Decisions for the maintainer

| # | Question | Recommendation | Decision |
|---|---|---|---|
| D1 | What crosses the wire from a device: row snapshots or named mutations? | **Named mutations**, replayed on the server through the generated delegates under the caller's context, one savepoint each. A pushed write is then exactly as powerful as the same call through a generated route. | open |
| D2 | How does a server write reach devices? | **A Postgres capture trigger per synced table**, writing a compacted change log. Every write path is covered, not only sync. | open |
| D3 | What is the pull cursor? | **`(txid, seq)` with the `pg_snapshot_xmin` gate.** A sequence or timestamp cursor skips transactions that commit late. The cost: a long transaction anywhere in the cluster delays pulls (never loses them). | open |
| D4 | When is the read policy applied to pulled rows? | **At pull time.** The log stores keys, not rows. Rows are fetched through the model's delegate with the puller's context, so a row the puller can no longer read arrives as a delete. | open |
| D5 | How does a device reconcile pending writes with server changes? | **Undo log plus rebase.** SQLite triggers keep pre-images of rows touched by pending mutations; every pull or rejection rewinds, applies, and replays. Mutators need not be idempotent. | open |
| D6 | The TTLs and their defaults? | **Mutation 7 d, client 30 d, tombstone 30 d**, with `client_ttl > mutation_ttl` enforced. That ordering prevents a mutation applying twice after a client is evicted. | open |
| D7 | Is sync exempt from the REST/RPC transport-parity rule? | **Yes, like MCP (ADR 0002 D5).** Sync is its own protocol, mounted next to either transport. Both transports get the same sync surface; it is not part of the application API. Whether its endpoints should also be RPC op ids is a follow-up. | open |
| D8 | Schema surface? | **`@@sync(scope: <expr>)` on a model**, generating the capture spec, the policy-checked row fetcher and default create/update/delete mutators for both roles. It requires a client-supplied primary key, and it is refused under `db = None` and in `include_client_schema!`. Custom mutations become procedures marked `@sync`. | open |
| D9 | Where does the engine live? | **One L2 crate, `cratestack-sync`, with feature-disjoint `server` and `client` halves.** The four entry macros stay disjoint (ADR 0013). Each emits only its own role's half. | open |
| D10 | Wire codec? | **CBOR by default once out of prototype**, JSON optional, through the existing codec layer. The prototype speaks JSON; the types are plain serde. | open |

## Context

CrateStack already runs one `.cstack` schema as a Postgres server (`include_server_schema!`) and as an
embedded SQLite store on native and `wasm32` with OPFS (`include_embedded_schema!`). The embedded role
enforces no policy, because a device is single-user. What was missing is the link between the two: a
write on a device reaching the server, a write on the server reaching the devices, and devices that
keep working while offline. The roadmap has listed "sync engine design" as the blocker for embedded
`@@audit`/`@@emit` since 0.3.

The only existing attempt is application code in `examples/react-nextjs-daisyui`. It uses an
`updatedAt` timestamp cursor with last-write-wins. That trusts device clocks and device rows, bypasses
policies, and can skip transactions that commit late.

## Decision

Adopt server-authoritative mutation replay (D1) over a trigger-captured, compacted, commit-ordered
change log (D2–D4), with an undo-log rebase on the device (D5). The protocol has four endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /sync/register` | Issue a client id bound to the authenticated principal |
| `POST /sync/push` | Replay contiguous, per-client-sequenced mutations; reject-and-consume per mutation; ack written into the change log in the same transaction as the writes |
| `POST /sync/pull` | Changes after a cursor, in the caller's server-derived scopes plus its private ack scope; pages never split a transaction |
| `GET /sync/poke` | Server-sent events carrying no data, driven by `NOTIFY` at commit |

Acks travel in the change log, not only in the push response. A device can then never drop a pending
mutation before it can see the server state that includes it.

### TTLs and protections

The TTLs are in D6.

- **Authentication.** Every endpoint goes through the application's own `AuthProvider`.
- **Client binding.** Client ids are server-issued and bound to a principal; any other principal
  gets `403` without the owner being named.
- **Scopes** are derived on the server and never named by the device.
- **Bounds.** Request bodies, mutations per push, bytes per mutation, pull pages, registrations per
  principal, poke streams per principal and the device's offline queue are all limited.
- **Rate limiting.** Optional per-principal limits through any `RateLimitStore`. A store error
  fails closed.
- **Post-dating.** A mutation dated in the future beyond the allowed clock skew is rejected, so it
  cannot dodge the TTL.
- **Account switch.** On `client_mismatch` the device engine halts rather than pushing one
  principal's queue as another's.

The design doc's §7 maps each of these to the test that proves it.

## Consequences

**Benefits:**

- A pushed mutation has exactly the power of a direct call.
- Server-side writes from any code path propagate without application code.
- Late-committing transactions cannot be skipped.
- Revoked visibility reaches the device as a delete.
- Offline writes are exact under rebase.
- TTLs bound both server history and stale intent.

**Costs:**

- One trigger per synced table, and one compacted log row per synced key.
- Shadow tables on the device, sized by the offline queue.
- Pull latency tied to the oldest open transaction in the cluster, so deployments should set
  `idle_in_transaction_session_timeout` and alert on transaction age.
- One HTTP/1.1 connection per device for pokes.
- Local mutators and server handlers must agree on what each mutation name means until `@@sync`
  generates both (D8).

## Alternatives considered

| Alternative | Why not |
|---|---|
| Row-state sync with last-write-wins | Trusts device rows and clocks, bypasses policy, loses concurrent edits, and its timestamp cursor skips rows. |
| CRDTs as the general model | Solves merge, not authorization. Most CrateStack data has relational invariants a CRDT cannot hold. Kept open as a per-field opt-in. |
| Logical replication / CDC (`wal2json`, Debezium) | Infrastructure the framework cannot assume. Replicates storage rows, not policy-filtered views. Does nothing for the upstream half. |
| Hooking the generated write path instead of a trigger | Misses procedures written in raw SQL, migrations, admin tools and `psql`, which is exactly the "mutation on the server" case. |
| Snapshotting row contents into the log | Leaks values a puller may no longer read, and grows the log with every version. |

## Follow-ups

1. `@@sync` grammar and codegen for both roles (D8). Then delete the hand-written registries from the
   example.
2. CBOR (D10), RPC addressing of the sync endpoints (D7), and metrics for transaction age and log size
   per scope.
3. Mutation-name versioning across app releases with a non-empty offline queue.
4. Device-key binding through COSE (ADR 0006) so a stolen bearer token plus a client id is not enough.
5. A security review before the crate is published.
