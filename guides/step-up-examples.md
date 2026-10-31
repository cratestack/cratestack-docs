---
title: "Step-up examples"
description: Runnable examples of a schema-declared step-up (`@authn`) from the server to a UI, in Rust on REST and RPC, and in the generated Dart (riverpod) and TypeScript (swr) clients.
---

# Step-up examples

<Note>
**Unreleased.** These examples ship with the `@authn` attribute and the typed `StepUpRequired`
refusal of [cratestack#1244](https://github.com/cratestack/cratestack/issues/1244) (ADR 0022). They
are stories 5 to 7 of [cratestack#1245](https://github.com/cratestack/cratestack/issues/1245).
</Note>

A procedure can say how recently and how strongly the caller must have authenticated:

```cstack
mutation procedure payInvoice(args: PayInvoiceArgs): Receipt
  @allow(auth() != null)
  @authn(maxAge: 300, amr: ["hwk"])
```

The generated code checks it after `@allow` admitted the caller, against the principal's
`auth_time` and `amr`, which your [auth provider](/guides/auth-provider) fills. A caller who does
not meet it is refused before the procedure runs, with RFC 9470's step-up signal:

* on REST, a `401` whose envelope carries `error: "insufficient_user_authentication"` and a
  `details` naming the requirements (`max_age`, `acr_values`, `amr`) and which ones the caller
  failed (`unmet`), plus a `WWW-Authenticate: Bearer error="insufficient_user_authentication", ...`
  challenge;
* on RPC, code `unauthenticated` with the same member and `details`, as a unary answer or as one
  frame of a batch (the other frames run).

Every generated client reads that refusal as `StepUpRequired`, and has a helper that re-proves and
sends the call **once** more: `retry_after_step_up` in Rust, `retryAfterStepUp` in Dart and
TypeScript. The helper never loops: a second refusal is returned to you.

Three examples run the whole path.

## Rust on REST and RPC

[`examples/step-up-procedures`](https://github.com/cratestack/cratestack/tree/main/examples/step-up-procedures)
needs no database. Its server is the generated REST and RPC routers behind
`SignedRequestAuthProvider`, CrateStack's in-house provider, with an id token verifier. The provider
copies the id token's `auth_time` and `amr`, plus `pop` for the signed request itself, onto the
principal; nothing in the server checks freshness or methods by hand. The generated Rust clients sign
every request with a device key and carry the id token.

A user who signed in with a password twenty minutes ago reads `balance` (no requirement), is refused
`payInvoice`, re-proves, and pays:

```rust
let receipt = retry_after_step_up(
    move || async move { client.procedures().pay_invoice(args, &[]).await },
    |step_up| std::future::ready(session.reprove(&step_up)),
)
.await?;
```

The same flow runs on an RPC unary call and in an RPC batch, where only the payment's frame is
refused and the retry sends the batch again.

```bash
cargo run -p step-up-procedures-example
cargo test -p step-up-procedures-example
```

The tests cover one step-up then one payment, a fresh session that needs none, the wire shape, a
declined re-proof (no retry), and a re-proof that still falls short (one retry, then the second
refusal comes back).

CrateStack does not run the re-authentication: that is your auth library's job. In the example, the
issuer's `reprove` stands in for it by minting a token that says "`hwk`, `user`, now". In a real
deployment the auth service answers a fresh proof, such as a signature by the device's user-present
key or a passkey assertion.

## Dart and TypeScript apps

[`examples/flutter-riverpod`](https://github.com/cratestack/cratestack/tree/main/examples/flutter-riverpod)
and
[`examples/react-vite-swr`](https://github.com/cratestack/cratestack/tree/main/examples/react-vite-swr)
share one schema, whose `clearDoneTasks` declares the same `@authn`. Each app has a "Clear done
tasks" button that goes through the generated mutation (`ClearDoneTasksController`,
`useClearDoneTasksMutation`) wrapped in `retryAfterStepUp`:

* the refusal opens a step-up screen built from `StepUpRequired` (what is required, and what is
  missing now);
* confirming re-proves and sends the call once more;
* a declined step-up, or any other refusal, shows a banner keyed on the refusal code: the `error`
  member when there is one (such as `insufficient_user_authentication`), else the envelope's `code`
  (`FORBIDDEN`, `UNAUTHORIZED`, ...).

```dart
final result = await retryAfterStepUp(
  () => controller.clearDoneTasks(args),
  (stepUp) => StepUpScreen.ask(context, stepUp),
);
```

```ts
const result = await retryAfterStepUp(() => trigger({ args: { boardId } }), ask);
```

The flows are tested without a server: `app/test/step_up_test.dart` (Flutter widget tests) and
`web/test/step-up.test.ts` (`pnpm --filter react-vite-swr-web test`).

<Warning>
In these two apps the session's facts travel as plain headers (`x-auth-time`, `x-auth-amr`), next
to the `x-auth-id` the example server already trusted, and "confirming with a security key" only
updates them. That keeps the apps about the client surface. A real provider must never trust such
headers: it reads `auth_time` and `amr` from a credential it verified, as
`step-up-procedures` does.
</Warning>
