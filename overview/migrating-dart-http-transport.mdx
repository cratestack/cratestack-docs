---
title: Migrating the Dart client to the HTTP transport
description: The four *DioAdapter classes are removed. How to move a generated Dart client to CratestackHttpAdapter or CratestackRpcHttpAdapter over CratestackDioTransport, what the error and query changes mean for existing code, and what is new.
---

# Migrating the Dart client to the HTTP transport

<Warning>
  **Since 0.16.0, breaking** ([cratestack#1204](https://github.com/cratestack/cratestack/issues/1204)).
  This is a hard cutover with no aliases: `CratestackDioAdapter`, `CratestackCborDioAdapter`,
  `CratestackRpcDioAdapter` and `CratestackRpcCborDioAdapter` are removed from the generated
  `runtime.dart`. A regenerated package that still names one does not compile. It applies to the
  `default` and `riverpod` presets, REST and RPC alike.
</Warning>

Regenerate the package, then make the changes below. The wire output is unchanged: the same URLs, headers and body bytes go out, pinned by golden requests captured from the retired adapters.

## 1. Replace the adapter

Dio becomes one transport, `CratestackDioTransport(dio)`, in the generated `lib/src/dio_transport.dart`. The adapter that used to wrap a `Dio` is now one class per protocol that takes a transport, a `baseUri` and a `format`.

| Before | After |
|---|---|
| `CratestackCborDioAdapter(dio: dio)` | `CratestackHttpAdapter(CratestackDioTransport(dio), baseUri: Uri.parse(baseUrl))` |
| `CratestackDioAdapter(dio: dio, useRustTransport: r)` | `CratestackHttpAdapter(CratestackDioTransport(dio), baseUri: Uri.parse(baseUrl), format: CratestackWireFormat.json, useRustTransport: r)` |
| `CratestackRpcCborDioAdapter(dio: dio)` | `CratestackRpcHttpAdapter(CratestackDioTransport(dio), baseUri: Uri.parse(baseUrl))` |
| `CratestackRpcDioAdapter(dio: dio)` | `CratestackRpcHttpAdapter(CratestackDioTransport(dio), baseUri: Uri.parse(baseUrl), format: CratestackWireFormat.json)` |

`format` defaults to `CratestackWireFormat.cbor`, which is what the two `*Cbor*` classes were.

A Riverpod override changes the same way:

```dart
// Before
flutterRiverpodClientAdapterProvider.overrideWithValue(
  CratestackDioAdapter(dio: myDio),
)

// After
flutterRiverpodClientAdapterProvider.overrideWithValue(
  CratestackHttpAdapter(
    CratestackDioTransport(myDio),
    baseUri: Uri.parse('https://api.example.com'),
  ),
)
```

### `baseUri` replaces `dio.options.baseUrl`

The adapter sends an absolute URI, so `CratestackDioTransport` no longer reads `dio.options.baseUrl`. Put the origin in `baseUri`. A path prefix on it is kept: `https://example.com/v1` joins `/v1` in front of every request path. Interceptors, base headers, certificate pinning and retry on the `Dio` keep working. An interceptor that reads `options.path` now sees an absolute URI.

### `useRustTransport`

Unchanged in meaning. `CratestackHttpAdapter(useRustTransport: true)` puts `cratestackUseRustTransportExtraKey` in `CratestackHttpRequest.extra`, `CratestackDioTransport` copies `extra` into `Options.extra`, and it is never a header.

## 2. Catch the new exception types

Nothing leaks a `DioException` any more.

| What happened | Before | After |
|---|---|---|
| REST, the server answered with an error status | a raw `DioException` | `CratestackRestException{status, body}` |
| RPC, the server answered with an error status | `CratestackRpcException` | `CratestackRpcException`, unchanged |
| No answer (refused, DNS, TLS, timeout, dropped, cancelled) | a `DioException` | a `CratestackTransportException`: `CratestackTransportAborted`, `Unsent`, `TimedOut` or `Broken` |

Code that wrapped a generated call in `on DioException` needs to catch `CratestackRestException` or `CratestackRpcException` for an error answer, and `CratestackTransportException` for the rest. See [Errors](/guides/dart-http-transport#errors) for what each kind means and which are safe to resend.

A response of an unsupported `Content-Type` is now a `FormatException` on the JSON REST adapter too; it used to hand back the raw string.

## 3. Check query maps for `null`

A canonical query encoder replaces Dio's. For every value the generated query builders emit, the query string is byte-identical to what Dio produced. The one behavioural difference is for a `null` value in a hand-built query map: it is now **omitted**, where Dio sent a bare `key`. The rules are listed under [Query encoding](/guides/dart-http-transport#query-encoding), and a double whose `toString()` has a `+` in the exponent (`1e+21`) is encoded as `1e%2B21`.

## What is new

Nothing below needs a change to keep working; it is there once you have migrated.

- **Abort.** `CratestackCallOptions.abort` and `CratestackRpcCallOptions.abort` cancel a call, which then throws `CratestackTransportAborted`.
- **Idempotency on REST.** `CratestackCallOptions.idempotencyKey` is sent as `Idempotency-Key`, as RPC already had.
- **Streaming.** `CratestackRpcHttpAdapter.stream()` delivers `application/cbor-seq` frames as they arrive instead of buffering the body.
- **Your own HTTP stack.** Implement `CratestackHttpTransport` instead of putting a Dio in front of it. See [Dart HTTP transport](/guides/dart-http-transport).
- **No Dio at all.** `--preset fespalier` generates the Riverpod surface over fespalier's `HttpTransport` with no `dio` in the pubspec. See [The `fespalier` preset](/guides/dart-fespalier-preset).

## Checklist

1. Regenerate the package with `cratestack generate-dart` (and `--run-build-runner`, or run `build_runner` yourself).
2. Replace each `*DioAdapter` per the table, and move `dio.options.baseUrl` into `baseUri`.
3. Replace `on DioException` around generated calls with the three exception families.
4. Look for `null` values in hand-built query maps.
5. Run `grep -rE "Cratestack(Cbor|Rpc|RpcCbor)?DioAdapter" lib test` and expect no hits.
