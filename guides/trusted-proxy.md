---
title: Trusted Proxy / Client IP
description: Configuring which reverse proxy CrateStack trusts to report the real client IP, and the two bootstrap steps the feature is inert without.
---

# Trusted Proxy / Client IP

`CoolContext::client_ip()` feeds the `actor` field on [audit log](./audit-log)
rows and is available to policies and procedures. By default it's the
verified TCP socket peer — the address the OS's own handshake produced,
never a client-suppliable value.

Behind a reverse proxy (nginx, an AWS ALB, a CDN), that socket peer is the
proxy's own address, not the real client's. The proxy forwards the real
address in a header — `X-Forwarded-For` or RFC 7239 `Forwarded` — but a
header is just bytes on the wire. Anyone who can reach your service
directly can set the same header to anything they want. Honoring it
unconditionally means an attacker can put whatever `client_ip` they like
into your audit trail.

`TrustedProxyConfig` closes that gap: forwarded headers are honored only
from peers you explicitly allowlist, and only as many hops deep as you
configure.

## Safe default

Unconfigured, nothing changes: `client_ip` is the verified socket peer if
one is available, or absent entirely if it isn't. `Forwarded` /
`X-Forwarded-For` are **never** consulted unless you apply a
`TrustedProxyConfig`. Nothing is ever guessed.

## Configuring the allowlist

```rust
use cratestack::{ForwardedHeader, TrustedProxyConfig};

let config = TrustedProxyConfig::trusting([
    "10.0.0.0/8".parse().unwrap(),      // internal load balancer subnet
    "203.0.113.5".parse::<std::net::IpAddr>().unwrap().into(), // exact peer
])
.max_hops(1)
.forwarded_header(ForwardedHeader::XForwardedFor); // the default; shown for clarity
```

- **Allowlist entries** are `ipnet::IpNet` — exact addresses (via
  `IpAddr`'s `Into<IpNet>`, a `/32` or `/128`) or CIDR ranges, so you can
  trust a whole subnet (a load balancer's private range) or a single
  known peer (a CDN edge IP).
- **`max_hops`** (default `1`) is how many entries deep into the chain to
  trust. `1` means "trust the immediate proxy's own contribution to the
  chain"; `2` means "trust two proxies deep" (e.g. CDN in front of a load
  balancer, both configured to append their own hop).
- **`forwarded_header`** selects which single header your proxy writes.
  Default is `ForwardedHeader::XForwardedFor` — what nginx, an AWS ALB,
  and HAProxy's defaults all actually send. Set it to
  `ForwardedHeader::Forwarded` only if your proxy is specifically
  configured to emit RFC 7239 `Forwarded` instead.

### Only one header is ever consulted

`Forwarded` and `X-Forwarded-For` are alternatives, not complements — a
real proxy is configured to emit one or the other, never both
meaningfully. `TrustedProxyConfig` picks exactly one and never falls back
to the other. This is deliberate, not an oversight: an earlier
implementation checked `Forwarded` first whenever it was present at all,
falling through to `X-Forwarded-For` only when `Forwarded` was absent.
Since real proxies only ever write `X-Forwarded-For`, any `Forwarded`
header reaching the origin was entirely attacker-authored — and it was
being trusted outright, with no hop-count or allowlist check applied to
it at all. Naming the header your proxy actually writes closes that
bypass: the header you didn't select is never even inspected, regardless
of who sends it or what it contains.

## Hop counting is right-to-left

`max_hops` counts inward **from the right end** of the header's
comma-separated chain — the end nearest your trusted proxy — not from the
left.

This matters because the left end of the chain is exactly the part an
untrusted client controls. A client can prepend as many fake entries as
it wants before the real chain starts; only the entries appended by
proxies you actually trust, on the right, are meaningful. Walking from
the left re-opens the same spoofing gap for any chain longer than one
hop — an attacker choosing `client_ip` just by sending a longer header.

```
X-Forwarded-For: 6.6.6.6, 203.0.113.9, 192.0.2.55
                 ^attacker  ^real client  ^what the trusted
                  spoofed                  proxy's own peer
                  (ignored)                 forwarded (its hop)
```

With a single trusted proxy directly in front of your service and
`max_hops(1)`, the rightmost entry — the immediate trusted proxy's own
contribution — is taken: `192.0.2.55` above. With two trusted hops (a CDN
in front of a load balancer, both configured to append) and
`max_hops(2)`, the second-from-right entry is taken: `203.0.113.9`, what
the CDN reported seeing. `max_hops` deeper than the actual chain length,
or `0`, yields no `client_ip` from the header rather than guessing.

The header is only consulted at all once the request's *verified socket
peer* — never the header itself — is confirmed to be in the allowlist.
An untrusted peer's forwarded headers are ignored outright, chain shape
notwithstanding.

## Bootstrap: two required steps

Applying `TrustedProxyConfig` alone does **nothing**. The feature needs
both of the following, and omitting either one silently leaves
`client_ip` at its unconfigured-default behavior with no error, warning
at the API level, or other visible signal at request time:

```rust
use std::net::SocketAddr;
use cratestack::axum::Extension;

let router = cratestack_schema::axum::router(db, procedures, JsonCodec, auth)
    // 1. Tell the router which peers/headers to trust.
    .layer(Extension(
        TrustedProxyConfig::trusting(["10.0.0.0/8".parse().unwrap()]).max_hops(1),
    ));

let listener = tokio::net::TcpListener::bind(addr).await?;

// 2. Serve through connect-info so a verified socket peer is ever
//    available to check against the allowlist in the first place.
axum::serve(
    listener,
    // NOT `router.into_make_service()` — that never populates
    // `ConnectInfo<SocketAddr>`, so step 1's allowlist has no peer
    // address to match against and every request behaves exactly as if
    // `TrustedProxyConfig` were never applied.
    router.into_make_service_with_connect_info::<SocketAddr>(),
)
.await?;
```

Step 2 is the one that's easy to miss, because nothing about step 1
fails without it — the config type-checks, the layer applies, the server
boots and serves traffic normally. `client_ip` is just silently `None`
(or the plain socket peer, if a load balancer terminates TCP directly
against your service) on every request, forever, with no per-request
error. Skipping it defeats the feature as completely as never applying
`TrustedProxyConfig` at all, just less visibly — the config *looks*
wired in a code review that only reads the `.layer(...)` call.

CrateStack logs a `tracing::warn!` once per process (not per request) if
a `TrustedProxyConfig` is present but a request arrives with no
`ConnectInfo` peer — that's the closest thing to an in-process signal
this misconfiguration gets, and it only fires after step 2 is still
missing at request time, not at boot.

### gRPC needs the same treatment, on its own router

A schema with `transport grpc` builds a **separate** `axum::Router` via
`into_router()` — not the same router instance `router()` returns.
Applying `TrustedProxyConfig` and `into_make_service_with_connect_info`
to `router()` only protects REST/RPC traffic; gRPC requests go through
`into_router()`'s own router entirely unaffected unless you wire both
steps onto it too:

```rust
let grpc_router = cratestack_schema::grpc::into_router(db, procedures, JsonCodec, auth)
    .layer(Extension(
        TrustedProxyConfig::trusting(["10.0.0.0/8".parse().unwrap()]).max_hops(1),
    ));

let grpc_listener = tokio::net::TcpListener::bind(grpc_addr).await?;
axum::serve(
    grpc_listener,
    grpc_router.into_make_service_with_connect_info::<SocketAddr>(),
)
.await?;
```

Both entry points reuse the same generated dispatch code internally, so
the trust logic itself is identical — only the router instance, and
therefore the bootstrap wiring, is separate.

## What this does *not* fix: #416's rate-limit / idempotency fingerprint

[Rate limiting](./rate-limiting) and [idempotency](./idempotency)'s
default principal fingerprints deliberately do **not** read forwarded
headers — they hash `Authorization` when present, and otherwise fall
back to `ConnectInfo<SocketAddr>` (the same verified socket peer this
page's feature also relies on). That's intentional: if the fingerprint
consulted `X-Forwarded-For`, a caller could pick their own rate-limit
bucket or idempotency key namespace just by setting the header, with no
proxy or allowlist involved at all — the exact bypass a fingerprint is
supposed to prevent.

But the practical effect is the same shape as this page's headline
warning: unless the router is served through
`into_make_service_with_connect_info`, `ConnectInfo` is never present,
and **every unauthenticated caller collapses onto a single shared
`"anonymous"` bucket** — no distinct rate-limit budget or idempotency
namespace per caller, regardless of how many distinct clients are
actually calling in. Wiring `into_make_service_with_connect_info` (this
page's step 2) is necessary for both features to distinguish callers by
IP, but a `TrustedProxyConfig` allowlist does not extend to them —
configuring trusted proxies for `client_ip` does not, by itself, give
rate limiting or idempotency per-client granularity for unauthenticated
traffic. Services that need that either authenticate before those
layers run, or supply an explicit `with_key_fn` / `with_principal_fingerprint`
callback.

## Read Next

1. [Audit log](./audit-log) — where `client_ip` is recorded, in the `actor` field
2. [Rate limiting](./rate-limiting) — the key function `ConnectInfo` also feeds, and why it doesn't read forwarded headers
3. [Idempotency](./idempotency) — same principal-scoping caveat as rate limiting
