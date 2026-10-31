---
title: "ADR 0022: Authentication Requirements in the Schema"
description: A procedure states how recently and how strongly its caller must have authenticated, with `@authn(maxAge, amr, acr)`. Generated code enforces it on every transport after the procedure's policy, and an unmet requirement is RFC 9470's step-up refusal, which every generated client reads as a typed value. Proposed.
---

# ADR 0022: Authentication Requirements in the Schema

## Status

**Proposed**, 2026-10-31. It is the first child story of epic
[cratestack#1244](https://github.com/cratestack/cratestack/issues/1244). The server side described here
is built in the framework PR for #1244 (§1–§4, §6). The typed client value (§5) is a second PR of the
same epic. Nothing here is a supported surface until this ADR is accepted.

The number is the next free one across both repositories, after
[ADR 0021](/internals/auth-seam-adr) (the `AuthProvider` seam). This ADR builds on 0021's refusal
envelope (`AuthRefusal`, §1 there) and principal contract (§2 there), and lives here because both the
grammar and the wire signal are user-visible.

## Date

- 2026-10-31: proposed, with §1–§4 and §6 built.

## Decisions for the maintainer

| # | Question | Proposal | State |
|---|---|---|---|
| D1 | How does a schema state the requirement? | **A procedure attribute, `@authn(maxAge: 300, amr: ["hwk"], acr: ["aal2", "aal3"])`.** Each key is optional, at least one is required, and each key appears at most once. | built |
| D2 | What does it mean? | **Checked after `@allow`/`@deny`**, against the principal contract's `auth_time`, `amr` and `acr`. A missing fact fails closed. | built |
| D3 | What does a refusal look like? | **RFC 9470**: a 401 `AuthRefusal` with `error: "insufficient_user_authentication"`, a `details` naming what is required and what was unmet, and a `Bearer` challenge on REST. | built |
| D4 | Which paths enforce it? | **Every path to the procedure**: REST, RPC unary, each RPC batch frame, MCP tool calls and non-HTTP callers. All of them go through the procedure's one authorize step. | built |
| D5 | How do clients react? | **A typed `StepUpRequired { maxAge, acrValues, amr, unmet }`** in Rust, Dart and TypeScript (and the riverpod, swr and fespalier layers). Each also gets a helper that retries **at most once** after a successful re-proof. | second PR |
| D6 | Who fills the facts? | **The provider.** `cratestack-auth` fills `auth_time` and `amr` (adding `pop` for a signed request), and COSE signers report `amr: ["pop"]`. Authkestra's providers map their own claims. | built |

## Context

Before this ADR, a policy could say *who* may call (`@allow(hasRole("teller"))`), never *how
recently* or *how strongly* they must have authenticated:

- `auth().<path>` compares only for equality, so `auth_time` cannot be checked against a clock.
- There was no set membership either, so "`amr` contains `hwk`" could not be written.
- A refusal was `401` or `403` with a fixed code, so a client could not tell "re-authenticate" from
  "never allowed".
- fespalier's `examples/cratestack` hand-codes "this call needs the user-present key" with a header
  and a server-side check (`payOrder`).
- Authkestra ships `max_age` re-authentication and `acr`/`amr` (its RFC-006 and RFC-007), but a
  CrateStack server had nowhere to declare them.

ADR 0021 gave every provider the reserved claims (`auth_time` in seconds, `amr` a list of strings,
`acr` a string) and gave every transport a refusal a provider can shape. This ADR puts a requirement
on top of both.

**Goals.** One declaration per operation, enforced by generated code on every transport, refused
with a standard signal, read by every generated client.

**Non-goals.** Running the re-authentication ceremony, which is the auth library's or the app's job.
Embedded schemas, which have no policy enforcement by design. A model-level `@@authn` (Q1).

## Decision

### 1. The attribute (D1)

```text
mutation procedure payOrder(args: PayArgs): Receipt
  @allow(auth() != null)
  @authn(maxAge: 300, amr: ["hwk", "user"], acr: ["aal2", "aal3"])
```

| Key | Value | Satisfied when |
|---|---|---|
| `maxAge` | whole seconds, 1 to 31 536 000 (one year) | `now - auth_time <= maxAge`. An `auth_time` in the future reads as fresh, because skew is the provider's concern. |
| `amr` | a non-empty list of quoted strings (RFC 8176 values) | every listed method is in the caller's `amr` |
| `acr` | a non-empty list of quoted strings | the caller's `acr` is one of them |

The rules for writing it:

- A value is letters, digits and `._:/~+-`, so a URN such as `urn:mace:incommon:iap:silver` is
  allowed. A value may not repeat within its list.
- Keys are camelCase, like `@mcp`'s.
- Lists use brackets, like an enum's values.
- The attribute is raw text in the IR, like `@isolation`, read by one function:
  `cratestack_core::schema::parse_authn_attribute`.
- The parser refuses anything that function does not read: an unknown key, a repeat, a non-list,
  an empty list, a second `@authn`, a misspelling (with a suggestion) or a space before `(`.
- The generator calls the same function, so a requirement it cannot read cannot compile either.

`@authn` is on the op contract's drop list: it decides who may call, not how bytes decode, so adding
one moves no client digest.

### 2. Semantics (D2)

The generated authorize step runs, in order:

1. argument validators;
2. `@allow`/`@deny`;
3. **`@authn`**;
4. any `@authorize` model check.

Putting `@authn` after the policy is deliberate. A caller the policy refuses gets 403: asking them to
re-authenticate cannot help. An anonymous caller a permissive `@allow` admits has no `auth_time`, so a
requirement refuses them with a step-up.

The facts are read through the principal contract's typed readers (`auth_time()`, `amr()`, `acr()`).
A missing or mistyped claim reads as absent, so the requirement fails closed.

Server time is the clock. `maxAge` is checked against `SystemTime::now()`, and
`cratestack::require_authn_at` takes an explicit time for tests and custom callers.

### 3. The wire signal (D3)

An unmet requirement is an `AuthRefusal` (ADR 0021 §1), so every transport renders it the way it
renders any provider refusal:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="insufficient_user_authentication", error_description="step-up authentication required", max_age="300", acr_values="aal2 aal3"

{
  "code": "UNAUTHORIZED",
  "message": "step-up authentication required",
  "error": "insufficient_user_authentication",
  "details": {
    "max_age": 300,
    "acr_values": ["aal2", "aal3"],
    "amr": ["hwk", "user"],
    "unmet": ["max_age", "amr"]
  }
}
```

- `details` uses RFC 9470's snake_case names. `max_age`, `acr_values` and `amr` are present only when
  required. `unmet` lists which of `max_age`, `acr` and `amr` failed, in that order.
- The challenge's `error_description` is the message. `max_age` and `acr_values` (space-separated)
  appear only when required. `amr` has no RFC 9470 challenge parameter, so it travels only in
  `details`.
- The challenge scheme is `Bearer`, as RFC 9470 writes it, whatever the provider's own scheme is.
  Q3 asks whether that should change.
- A client classifies a remote error as a step-up when its status is 401 (RPC: `unauthenticated`)
  **and** its `error` member is `insufficient_user_authentication`. A plain 401 is not a step-up.

### 4. Transports (D4)

Every transport reaches a procedure through the generated `authorize_with_db` / `invoke_with_db`
(or the db-less `authorize` / `invoke`), and all four call `require_authn`, so no transport can skip
it.

| Path | Refusal |
|---|---|
| REST | 401, envelope and challenge as in §3 |
| RPC unary | 401, `code: "unauthenticated"`, the same `details` and `error` member, no challenge |
| RPC batch | **per frame**: the frame that needs a step-up carries the error, and its neighbours run. The envelope authenticated once, so `auth_time` is the envelope's. |
| MCP tool | an `isError` result whose text is the REST envelope, and the tool never runs. ADR 0002 D5 exempts MCP from transport parity, but the requirement lives in the authorize step MCP already calls, so an `@mcp(tool)` procedure cannot skip it. |
| Non-HTTP callers | the `CratestackError::AuthRefused` the authorize step returns |

### 5. Clients (D5)

Each generated client gains:

- a `StepUpRequired` value (`max_age` / `maxAge`, `acr_values` / `acrValues`, `amr`, `unmet`), read
  from a refusal by the rule in §3 and tolerant of missing or mistyped fields;
- a helper that retries a call **at most once** after a successful re-proof:
  - Rust: `retry_after_step_up`;
  - Dart and TypeScript: `retryAfterStepUp`.

The riverpod, swr and fespalier layers surface the typed value unchanged. fespalier maps it onto its
session, so the app re-proves (a user-present key, a passkey) and retries; that mapping is tracked in
fespalier's epic. This half of the epic is a separate PR.

### 6. Who fills the facts (D6)

| Provider | `auth_time` | `amr` | `acr` |
|---|---|---|---|
| `cratestack-auth`, a user with an id token | the token's `auth_time` claim, set to the mint time by `default_id_token_claims` | the token's `amr`, plus `pop` (RFC 8176 proof of possession: the request is signed with the bound key) | none yet |
| `cratestack-auth`, a service key | none | `["pop"]` | none |
| `cratestack-cose`, a verified signer | none | `["pop"]` | none |
| Authkestra OIDC (`examples/auth-pluggable`) | the token identity's `auth_time` attribute | its `amr` | its `acr` |

An issuer that re-mints a token without a fresh user proof must keep the earlier `auth_time`.
`cratestack-auth`'s claim doc says so.

## Consequences

**Benefits.**

- A step-up rule is one line in the schema, enforced everywhere the procedure is reachable.
- The signal is the standard one, so OAuth and OIDC clients that already speak RFC 9470 understand
  it.
- Any provider plugged in through ADR 0021's seam satisfies a requirement by filling three reserved
  claims.

**Costs.**

- One more attribute in the grammar, and one more step in every authorize call. With no `@authn` the
  step is a `None` check.
- A provider that does not know `auth_time` fails every `maxAge` closed. That is intended, and
  `details.unmet` names the part.

## Alternatives considered

| Alternative | Why not |
|---|---|
| A policy expression, `@allow(auth().auth_time > now() - 300)` | Needs ordering, a clock and set membership in the policy language. It would make a step-up indistinguishable from a 403, and the refusal could not say what to re-prove. |
| Check before `@allow` | Asks a caller to re-authenticate for an operation they may never call. |
| A per-transport check | Exactly the parity gap ADR 0021 closed. The authorize step is the one path every transport takes. |
| A 403 with `insufficient_scope` | RFC 9470 defines `insufficient_user_authentication` as a 401 so a client knows to re-authenticate; 403 means re-authenticating will not help. |

## Open questions for the maintainer

| # | Question | Proposal |
|---|---|---|
| Q1 | A model-level `@@authn("update,delete", maxAge: 300)`? Model writes are enforced in the runtime ORM, with no single generated choke point per operation. | Later: a dispatch-level pre-check covers REST and RPC but not direct ORM callers; decide whether that split is acceptable first |
| Q2 | A `keyRole: "userPresent"` key, reading ADR 0021's `key_role`? | Yes, next. fespalier's `payOrder` needs exactly "signed by the user-present key", which `amr: ["user"]` approximates only when the provider fills it |
| Q3 | Should the challenge scheme follow the provider (`Signature`, `DPoP`) rather than always `Bearer`? | Keep `Bearer` (RFC 9470's) until a client needs otherwise; `details` carries everything regardless |
| Q4 | Should an `acr` list express an order ("`aal2` or stronger")? | No. List every acceptable class: the schema cannot know a provider's ordering |
| Q5 | Should `cratestack diff` report adding or tightening an `@authn`? | Yes, as a Warning: existing clients start receiving 401s. `diff` does not compare procedure attributes today |
| Q6 | Should `auth_time` far in the future (clock skew) be refused? | No, the provider owns skew; revisit if a provider is found to stamp future times |

## Implementation plan

1. This ADR.
2. Parser, LSP and the op contract: built.
3. Enforcement on REST and RPC unary: built.
4. Enforcement per RPC batch frame, and on MCP tools: built.
5. Rust client `StepUpRequired`.
6. Dart client, with the riverpod and fespalier layers.
7. TypeScript client, with swr.
8. In-house providers fill `auth_time` and `amr`: built.

Items 5–7 are the clients PR.
