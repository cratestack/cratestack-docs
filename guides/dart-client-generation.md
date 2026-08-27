---
title: Dart client generation
description: Generate a typed Dart/Flutter package — CRUD APIs, procedures, and (with `--preset riverpod`) a full generated Riverpod provider surface — from a `.cstack` schema with `cratestack generate-dart`.
---

# Dart client generation

`cratestack generate-dart` renders a complete, publishable Dart package from a parsed `.cstack` schema: typed models, a client with per-model CRUD APIs and procedure APIs, and — with `--preset riverpod` — a full set of generated [Riverpod](https://riverpod.dev) providers on top of it. It's implemented by `cratestack-client-dart` and uses the same schema-first approach as the TypeScript and Rust client generators — there is no OpenAPI/Swagger document in the middle, the `.cstack` file is the only source of truth.

This guide covers generating the package, the `default` and `riverpod` presets, what the `riverpod` preset actually generates and why it's shaped the way it is, and a full getting-started walkthrough from schema to a running Flutter screen.

## Generate the package

### From the CLI

```bash
cargo run -p cratestack-cli -- generate-dart \
  --schema examples/react-vite-swr/schema.cstack \
  --out packages/board_client \
  --library-name board_client \
  --base-path /api
```

Once the CLI binary is installed, drop the `cargo run -p cratestack-cli --` prefix and call `cratestack generate-dart ...` directly.

| Flag | Required | Default | Notes |
|---|---|---|---|
| `--schema` | yes | — | path to the `.cstack` file |
| `--out` | yes | — | output directory for the generated package |
| `--library-name` | no | `cratestack_client` | written into the generated `pubspec.yaml`; also derives the top-level client class name and the barrel file `lib/<library_name>.dart` |
| `--base-path` | no | `/api` | default API base path baked into the runtime |
| `--template-dir` | no | none | override individual `.j2` templates; anything not overridden falls back to the bundled default |
| `--check` | no | off | drift-detection mode: generate in memory and diff against `--out` instead of writing; exits non-zero and lists the files that differ |
| `--preset` | no | `default` | `default` or `riverpod` — see below |
| `--run-build-runner` | no | off | after generation, run `dart run build_runner build --delete-conflicting-outputs` in `--out` — see [The `--run-build-runner` flag](#the-run-build-runner-flag) |
| `--no-native-cbor` | no | off | fall back to pure-Dart `package:cbor` instead of the native `cratestack_cbor` codec, which is the default — see [The CBOR codec](#the-cbor-codec) |

### The two presets

`--preset` selects the generated package's shape:

- **`default`** — one monolithic `lib/src/models.dart` and one monolithic `lib/src/apis.dart`. This layout is unchanged from before the `riverpod` preset existed, and it stays the default — you don't need `--preset` to get it. It is **not** byte-identical output anymore, though: as of the builder-generation move (see [The `--run-build-runner` flag](#the-run-build-runner-flag) below), every data class in `models.dart` now carries a `@CratestackBuilder(...)` annotation and the file gains a `part 'models.builder.dart';` directive, so a `default`-preset regeneration now needs a `build_runner` pass it never needed before.
- **`riverpod`** (opt-in, epic [#297](https://github.com/cratestack/cratestack/issues/297)) — one file per model under `lib/src/models/` (a shared `lib/src/models/shared_types.dart` for cross-model types like `Page`/`PageInfo`), procedures in their own `lib/src/procedures.dart`, and package-wide DI providers (`xAdapterProvider`, `xClientProvider`) living in `lib/src/client.dart`. Every model and procedure-argument file also declares a full set of generated `@riverpod` providers — see [The `riverpod` preset](#the-riverpod-preset) below.

```bash
cargo run -p cratestack-cli -- generate-dart \
  --schema examples/react-vite-swr/schema.cstack \
  --out examples/flutter-riverpod/client \
  --library-name flutter_riverpod_client \
  --preset riverpod
```

### Picking REST or RPC

There's no separate flag for this — exactly like the TypeScript generator, `generate-dart` reads `schema.transport` off the parsed `.cstack` file and switches templates accordingly. REST is the default; a schema opts into RPC with a `transport rpc` directive at the top of the file. Both presets support both transports. See [Using the riverpod preset over RPC](#using-the-riverpod-preset-over-rpc) below and the [RPC transport](/guides/rpc-transport) guide for the full transport design.

### Regenerating after schema changes

The generated package is build output, not hand-edited source. Whenever the `.cstack` schema changes, re-run the same `generate-dart` command against the same `--out` directory — there's no incremental/merge step, the generator overwrites the package's `lib/src/` files wholesale. Use `--check` in CI to catch a schema change that wasn't followed by regeneration; it never writes files.

## The `riverpod` preset

### Package layout

```
lib/
  <library_name>.dart          # barrel: exports everything below
  src/
    runtime.dart                # CratestackClientAdapter / CratestackRpcAdapter, request plumbing
    constants.dart               # field-name / include-name constants
    queries.dart                 # CratestackFetchQuery / CratestackListQuery (REST only)
    client.dart                  # top-level client class + xAdapterProvider / xClientProvider
    procedures.dart              # procedure argument classes, ProceduresApi, one @riverpod provider per procedure
    models/
      shared_types.dart          # Page<T> / PageInfo and any type referenced by more than one model
      <model>.dart                # per model: data classes, <Model>Api, one @riverpod provider per operation
```

This is the real layout of `examples/flutter-riverpod/client/`, a generated (checked-in) package driven from `examples/react-vite-swr/schema.cstack`'s `Board`/`Task` models and `estimateFocusMinutes` procedure.

### The DI layer providers are built on top of

Every generated package — `default` or `riverpod` — declares two `Provider`s in `lib/src/client.dart`, unchanged in shape by the `riverpod` preset:

```dart
final flutterRiverpodClientAdapterProvider = Provider<CratestackClientAdapter>((ref) {
  throw UnimplementedError('Override flutterRiverpodClientAdapterProvider before reading the generated CrateStack client.');
});

final flutterRiverpodClientClientProvider = Provider<FlutterRiverpodClientCratestackClient>((ref) {
  return FlutterRiverpodClientCratestackClient(
    ref.watch(flutterRiverpodClientAdapterProvider),
    basePath: ref.watch(flutterRiverpodClientBasePathProvider),
  );
});
```

`xAdapterProvider` throws until overridden — that's the single override point a consumer supplies to point the generated client at a real server (or a mock, in tests):

```dart
ProviderScope(
  overrides: [
    flutterRiverpodClientAdapterProvider.overrideWithValue(
      CratestackDioAdapter(dio: myDio),
    ),
  ],
  child: const MyApp(),
);
```

Every other generated provider in the package — every model's read/write providers, every procedure's provider — is built by watching `xClientProvider` (indirectly, via a per-model `Provider<XApi>`), not by talking to the adapter directly. Overriding `xAdapterProvider` alone is enough to redirect the entire generated surface.

### One `@riverpod` provider per operation

On top of that pre-existing DI layer, each model file declares one `@riverpod` provider per CRUD operation, and each procedure gets one too. Reads and writes are shaped differently on purpose.

**Reads become parameterized `Future` providers.** A model's `get`/`list` operations become plain `@riverpod` functions:

```dart
@riverpod
Future<Board> board(
  Ref ref,
  int id, {
  CratestackFetchQuery? query,
}) {
  return ref.watch(flutterRiverpodClientBoardApiProvider).get(id, query: query);
}

@riverpod
Future<IList<Board>> boardList(Ref ref, {
  CratestackListQuery? query,
}) {
  return ref.watch(flutterRiverpodClientBoardApiProvider).list(query: query);
}
```

Because `board` takes an argument, `riverpod_generator` compiles it to a family — call it as `boardProvider(id)`. `boardList` takes no *required* argument, but it still takes an optional named one (`query`), which also makes it a family — even the plain, unfiltered case has to be called as `boardListProvider()`, not watched as a bare identifier.

**Writes become `AsyncNotifier` controllers, not `FutureProvider`s.** A mutation isn't a value to cache and re-fetch for every listener — it's an action with its own loading/error/success lifecycle. Forcing `create`/`update`/`delete` into the same `FutureProvider` shape as a read would lose that: there'd be nowhere to observe "is this create in flight right now" independent of re-triggering it. `AsyncNotifier`'s `state` gives a widget that lifecycle for free (`.isLoading`, `.hasError`, `.value`) while the method itself still returns the created/updated/deleted record directly for callers that just want the result:

```dart
@riverpod
class BoardCreateController extends _$BoardCreateController {
  @override
  FutureOr<Board?> build() => null;

  Future<Board> create(CreateBoardInput input) async {
    state = const AsyncValue.loading();
    try {
      final result = await ref.read(flutterRiverpodClientBoardApiProvider).create(input);
      state = AsyncValue.data(result);
      return result;
    } catch (error, stackTrace) {
      state = AsyncValue.error(error, stackTrace);
      rethrow;
    }
  }
}
```

The update controller's method is named `save`, not `update` — `AsyncNotifier`'s own generated base class already declares an `update(...)` method for mutating `state` from its previous value, and a same-signature override collides with it (a real `dart analyze` error, not a style choice). Every model gets `<Model>CreateController`, `<Model>UpdateController` (`.save(id, patch)`), and `<Model>DeleteController` (`.delete(id)`); a query-kind procedure gets a `Future` provider matching the read shape, a mutation-kind procedure gets a controller matching the write shape.

### List/get query forwarding

`board`/`boardList` (and every other model's equivalent pair) forward their optional `query` parameter straight into the underlying `CratestackFetchQuery`/`CratestackListQuery` — the same filter/sort/pagination/field-selection builder the plain (non-Riverpod) generated client already exposes. So a screen that needs a filtered or sorted list doesn't have to fall back to hand-written providers:

```dart
final published = ref.watch(
  boardListProvider(query: const CratestackListQuery(where: 'published=true', sort: '-id', limit: 20)),
);
```

Both query classes carry real `operator ==`/`hashCode` for the same reason described next — a freshly-built query with the same values as a previous one has to be `==` to it, or the family provider never dedupes.

### Real equality via `dart_mappable` (issue #325)

Every `riverpod`-preset data class — models, `Create<Model>Input`/`Update<Model>Input`, and procedure argument wrapper types (`EstimateFocusMinutesArgs`, etc.) — is annotated `@MappableClass()` and gets a real `operator ==`, `hashCode`, and `copyWith` from [`dart_mappable`](https://pub.dev/packages/dart_mappable), expanded by `dart_mappable_builder` in the same `build_runner` pass as `riverpod_generator`.

This matters because of how Riverpod caches family providers. `estimateFocusMinutesProvider(EstimateFocusMinutesArgs(...))` is a family — Riverpod dedupes family provider instances by comparing the argument with `==`, not by object identity. Before issue #325, a generated class like `EstimateFocusMinutesArgs` had no custom `==`, so it fell back to Dart's default identity equality. A perfectly ordinary Flutter pattern — building a fresh argument object on every `build()` call, e.g. `EstimateFocusMinutesArgs(args: FocusEstimateArgs(taskCount: openCount, minutesPerTask: 25))` recomputed from live state — meant every rebuild constructed a *structurally identical but not identical* argument, which never matched the previous instance, so the provider tore down and restarted `AsyncLoading` forever. It never settled.

That's fixed now, unconditionally, for every generated class in this preset. A reader building their own `@riverpod` provider around a generated model or argument type doesn't need to memoize the argument, cache it in a field, or work around the identity trap — `EstimateFocusMinutesArgs(args: FocusEstimateArgs(taskCount: openCount, minutesPerTask: 25))` built fresh on every rebuild is `==` to the last one whenever the field values match, and the family cache dedupes it correctly. `examples/flutter-riverpod/app/test/estimate_focus_minutes_family_cache_test.dart` is the regression test proving exactly this.

Relation fields get the same treatment for free: a `Task.board` field (typed `Board?`) recurses into `Board`'s own generated `==` rather than falling back to identity, and list-valued relations get element-wise comparison rather than `List.==`.

A `FindMany<Model>` procedure argument is the same story one level deeper: `PostFindMany`'s own `where`/`orderBy` fields are typed `PostWhere?`/`List<PostOrderByClause>?`, and `PostWhere`'s own fields are typed `StringFilter?`/`NumberFilter?`/etc. — every one of those, including the six shared filter classes, is `@MappableClass()`-annotated too, so a freshly-built `PostFindMany` passed to a `@riverpod` family provider gets the identical deep-equality treatment described above, all the way down. See [Search with Filters](./find-many) for the full `FindMany<Model>` contract, and [Pagination](./pagination#procedure-arguments-pageinput) for `PageInput` (a plain, hardcoded procedure-argument class like `Page`/`PageInfo`, generated the same way regardless of preset).

## The `--run-build-runner` flag

<Warning>
  **Breaking change, landing in the next CrateStack release** (merged to `main`, not yet published —
  the current release is 0.8.13). Generated Dart no longer emits `{Class}Builder` classes inline.
  Every generated data class — models, `Create<Model>Input`/`Update<Model>Input`,
  `<Model>Where`/`<Model>OrderByClause`/`<Model>FindMany`, `type` blocks, and per-procedure argument
  classes — now carries a `@CratestackBuilder(...)` annotation from
  [`cratestack_annotations`](https://pub.dev/packages/cratestack_annotations), and its containing file
  gains a `part '<stem>.builder.dart';` directive that
  [`cratestack_builder`](https://pub.dev/packages/cratestack_builder)'s `build_runner` step expands.
  The builder's own API — setters, `add<Field>`, `build()` — is unchanged; only how it comes into
  existence changed. **This is why this whole section now applies to the `default` preset too**: it
  previously needed no build step at all, so a regenerated `default`-preset client will not
  `flutter analyze` clean until `build_runner` has run — and if you commit your generated client, a
  bare upgrade-and-regenerate leaves your tree broken until you add that step. The `riverpod` preset
  already ran `build_runner` for its own `@riverpod`/`dart_mappable` codegen, so for it this is
  additive, not new. Generated `.builder.dart` output is a build artifact, not generator output —
  gitignore it (`**/*.builder.dart`) in your own repo, the same way this repo's own
  `examples/flutter-riverpod/.gitignore` does for its committed example, alongside the pre-existing
  `*.g.dart`/`*.mapper.dart` patterns. TypeScript clients are unaffected by any of this — TS has no
  generated builders and never did. Rust clients are unaffected too — the Rust macro still emits
  builders at compile time, no build step involved.
</Warning>

Two independent codegen passes need `build_runner` now, layered on top of each other:

- **Every preset** — every generated data class carries `@CratestackBuilder(...)`; its containing
  file gets a `part '<stem>.builder.dart';` that `package:cratestack_builder` expands into the actual
  `{Class}Builder`.
- **`riverpod` preset only** — on top of that, the `@riverpod` and `@MappableClass()` annotations are
  inert until `build_runner` expands them into `.g.dart`/`.mapper.dart` part files too.

Without running it, neither preset's output compiles, let alone `flutter analyze` clean.

Pass `--run-build-runner` (issue [#303](https://github.com/cratestack/cratestack/issues/303)) to have the CLI do it for you right after generation:

```bash
cargo run -p cratestack-cli -- generate-dart \
  --schema examples/react-vite-swr/schema.cstack \
  --out examples/flutter-riverpod/client \
  --library-name flutter_riverpod_client \
  --preset riverpod \
  --run-build-runner
```

It's opt-in, not the default — a Rust CLI unpromptedly shelling out to a separate Dart toolchain would be a surprising behavior change for existing or scripted callers, so you have to ask for it. It requires a Dart SDK on `PATH`; it has no effect together with `--check` (drift-detection mode never writes files, so there's nothing to run `build_runner` against). `--check` no longer sees the expanded builder either way — it only sees the annotation and the `part` directive, since drift-detection mode never runs `build_runner`.

Without the flag, the generated README tells you the manual two-step equivalent — this now applies to the `default` preset too, not just `riverpod`:

```bash
cratestack generate-dart --schema schema.cstack --out .
cd . && dart run build_runner build --delete-conflicting-outputs
```

Re-run `build_runner` (or pass `--run-build-runner` again) every time you regenerate — its output tracks the *generated* source, is a build artifact rather than generator output, and should be gitignored in your own repo, so a fresh clone always needs this step before the package will analyze or build. The generated `pubspec.yaml` reflects the new dependencies either way: `cratestack_annotations` under `dependencies:` (runtime, zero transitive dependencies of its own), and `cratestack_builder` plus `build_runner` under `dev_dependencies:`.

### These two are API floors, not the release version

Both are emitted as **API-compatibility floors** — `^0.8.10`, naming the
earliest release whose annotation surface the generated code actually
needs — not as the version of CrateStack that generated the client
([#754](https://github.com/cratestack/cratestack/issues/754)).

They used to name the current workspace version. Because pub.dev
publishing runs off a tag pushed *after* the version-bump PR merges, that
meant every generated client spent each release cycle asking for a
version pub.dev could not serve yet.

Two consequences worth knowing:

- **What you actually resolve is unchanged today.** Pub resolves
  `>=0.8.10 <0.9.0` to the newest 0.8.x. After 0.9.0 ships, generated
  clients keep resolving 0.8.x until the floor is deliberately raised —
  staleness rather than breakage.
- **Generator output no longer moves with the release.** Committed
  snapshots and example clients survive a version bump instead of being
  invalidated by it, which is why `just regen-examples --check` stays
  green across one.

The floors are backed by tests rather than comments: the emitted floor
must be at least the one `cratestack_builder`'s own pubspec declares, and
both must sit strictly below the current, not-yet-published workspace
version.

<Note>
`cratestack_cbor` is **not** covered by this and still derives its
emitted requirement from the release version — see [the CBOR
codec](#the-cbor-codec) below.
</Note>

## The CBOR codec

CBOR encode/decode sits on every request a generated client makes. By default the generated package depends on [`cratestack_cbor`](https://pub.dev/packages/cratestack_cbor) (issue [#563](https://github.com/cratestack/cratestack/issues/563)) — the framework's own `cratestack-codec-cbor` Rust crate, bound through flutter_rust_bridge natively and wasm-bindgen on web. Because both sides are the same Rust codec the server uses, the wire bytes are identical across languages, the same property `@cratestack/cbor-node` and `@cratestack/cbor-web` give the JavaScript clients.

Pass `--no-native-cbor` to fall back to [`package:cbor`](https://pub.dev/packages/cbor), which is pure Dart and runs anywhere:

```bash
cratestack generate-dart \
  --schema schema.cstack \
  --out ./client \
  --no-native-cbor
```

The choice is purely additive. Every other emitted file is byte-identical either way; only the `pubspec.yaml` dependency and the runtime's codec wiring change.

<Warning>
  **Breaking change, landing in the next CrateStack release** (merged, not yet published — the current release is 0.8.7, where `--native-cbor` is still the flag). The native codec used to be opt-in behind that flag. It is now the default, and that flag has been **removed** — a bare `--flag` cannot express "on by default", so it was replaced by `--no-native-cbor`. An existing `--native-cbor` invocation is an unknown-argument error, not a no-op. Drop it (native is now the default), or swap it for `--no-native-cbor` if you were relying on the pure-Dart codec.
</Warning>

### Platform support

`cratestack_cbor` vendors prebuilt binaries rather than building Rust on a consumer's machine, so a platform works only if a binary was vendored for it:

| Platform | Supported |
|---|---|
| Linux x86_64 | yes |
| Windows x64 | yes |
| macOS (universal arm64 + x86_64) | yes |
| iOS (device + simulator) | yes |
| Android (`arm64-v8a`, `x86_64`, `armeabi-v7a`) | yes |
| Web | yes (wasm-bindgen) |
| Linux arm64 | **no** — `createCborCodec()` throws `UnsupportedError` |

<Note>
  Windows, macOS and iOS support shipped in **`cratestack_cbor` 0.8.7**. Earlier published versions resolve but throw `UnsupportedError` on those three platforms, so if your generated `pubspec.yaml` pins an older constraint, raise it to `^0.8.7` before shipping to them. The generator version-locks this dependency to its own version, so a client generated by CrateStack 0.8.7 or later already asks for a release that has them.
</Note>

**Linux arm64 is the reason `--no-native-cbor` exists.** It is the one target the native codec does not cover, so a client generated for it needs the pure-Dart fallback; `package:cbor` runs anywhere. Everywhere else, the default gives you the same codec the server runs.

## Getting started: schema to a running screen

This walkthrough follows `examples/flutter-riverpod/` in the framework repo — a real, checked-in Flutter app that consumes a `--preset riverpod` client with zero hand-written providers, built from the same schema `examples/react-vite-swr` already uses for its TypeScript sibling.

The schema (`examples/react-vite-swr/schema.cstack`) declares `Board`/`Task` models with a relation and one query procedure:

```cstack
model Board {
  id Int @id
  name String

  @@allow("read", auth() != null)
  @@allow("create", auth() != null)
  @@allow("update", auth() != null)
  @@allow("delete", auth() != null)
}

model Task {
  id Int @id
  title String
  done Boolean
  boardId Int
  board Board @relation(fields:[boardId],references:[id])

  @@allow("read", auth() != null)
  @@allow("create", auth() != null)
  @@allow("update", auth() != null)
  @@allow("delete", auth() != null)
}

type FocusEstimateArgs {
  taskCount Int
  minutesPerTask Int
}

type FocusEstimateResult {
  totalMinutes Int
}

procedure estimateFocusMinutes(args: FocusEstimateArgs): FocusEstimateResult
  @allow(auth() != null)
```

**1. Bring up the server** (reused from `react-vite-swr` — this example owns no Rust crate of its own):

```bash
docker compose up -d postgres
DATABASE_URL=postgres://cratestack:cratestack@localhost:55432/cratestack_test \
  cargo run -p react-vite-swr-example
# -> listening on http://127.0.0.1:3210 (routes under /api)
```

**2. Generate the client and run `build_runner` in one command:**

```bash
cargo run -p cratestack-cli -- generate-dart \
  --schema examples/react-vite-swr/schema.cstack \
  --out examples/flutter-riverpod/client \
  --library-name flutter_riverpod_client \
  --preset riverpod \
  --run-build-runner
```

**3. Override the adapter provider once, at the app root** (`app/lib/main.dart`) — the one override every consumer of this preset needs:

```dart
void main() {
  runApp(
    ProviderScope(
      overrides: [
        flutterRiverpodClientAdapterProvider.overrideWithValue(
          CratestackDioAdapter(dio: buildAppDio()),
        ),
      ],
      child: const RiverpodExampleApp(),
    ),
  );
}
```

`buildAppDio()` (`app/lib/src/runtime.dart`) is just a `Dio` pointed at `http://127.0.0.1:3210` with a stand-in `x-auth-id: 1` header — everything downstream of this one override (every provider below) comes from the generated client.

**4. Consume the generated providers in a widget** (`app/lib/src/screens/boards_screen.dart`, trimmed):

```dart
class _BoardsScreenState extends ConsumerState<BoardsScreen> {
  final _nameController = TextEditingController();

  Future<void> _addBoard() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) return;
    await ref.read(boardCreateControllerProvider.notifier).create(
          CreateBoardInput(id: DateTime.now().millisecondsSinceEpoch, name: name),
        );
    _nameController.clear();
    // No hand-written cache invalidation — ordinary Riverpod usage on an
    // already-generated provider.
    ref.invalidate(boardListProvider());
  }

  @override
  Widget build(BuildContext context) {
    final boards = ref.watch(boardListProvider());
    final creating = ref.watch(boardCreateControllerProvider).isLoading;

    return boards.when(
      data: (items) => ListView.builder(
        itemCount: items.length,
        itemBuilder: (context, index) => ListTile(title: Text(items[index].name ?? '')),
      ),
      loading: () => const CircularProgressIndicator(),
      error: (error, _) => Text('Failed to load boards: $error'),
    );
  }
}
```

No provider in this file is hand-written — `boardListProvider`, `boardCreateControllerProvider`, and `CreateBoardInput` all come straight from the generated `client/` package. Refreshing the list after a write is `ref.invalidate(boardListProvider())`, an ordinary Riverpod call against an already-generated provider — not a bespoke invalidation mechanism.

`examples/flutter-riverpod/README.md` documents the full command sequence end to end, including materializing platform scaffolds with `flutter create .` and running the app with `flutter run -d macos`.

## Using the riverpod preset over RPC

For a `transport rpc` schema, the generated shape is the same — one `@riverpod` provider per operation, controllers for writes — but two things differ because RPC has no per-model REST routes:

- Providers are built by watching a `Provider<CratestackRpcAdapter>` (e.g. `tinyRpcClientAdapterProvider`) instead of `Provider<CratestackClientAdapter>`.
- There's no typed `CratestackListQuery`/`CratestackFetchQuery` for RPC to forward (RPC dispatches by op ID, not URL + query string), so a list provider's optional argument is a raw `IMap<String, Object?>` instead:

```dart
@riverpod
Future<IList<Widget>> widgetList(Ref ref, {
  IMap<String, Object?>? input,
}) {
  return ref.watch(tinyRpcClientWidgetApiProvider).list(input: input?.unlock ?? const <String, Object?>{});
}
```

It's `IMap`, not a plain `Map`, for the same reason `CratestackListQuery` needed hand-rolled `==` for REST — `Map`'s default equality is identity-based, which would reintroduce the exact family-caching bug issue #325 fixed for typed classes. `IMap` (from `fast_immutable_collections`, already a `riverpod`-preset dependency) has real value equality, so a freshly-built-but-equal `input` map still dedupes.

Everything else — `widget(id)`, `WidgetCreateController.create(...)`, `WidgetUpdateController.save(id, patch)`, `WidgetDeleteController.delete(id)`, one `@riverpod` function per query procedure and one controller per mutation procedure — is structurally identical to the REST case above.

## Computed-field params

A model with a `@computed(params: <Type>?)` field gets a generated
`<Model>ComputedParams` class, and its `get`/`list` calls — plain APIs and the
riverpod convenience providers, REST and RPC alike — accept it as an optional
named parameter:

```dart
final image = await client.images.get(
  7,
  computedParams: ImageComputedParams(proxyUrl: ProxyParams(width: 800)),
);
```

The class has value equality, so riverpod family providers keyed on it cache
correctly, and it comes with the same fluent builder every other generated data
class has — expanded by `build_runner` from a `@CratestackBuilder(...)`
annotation, like every other generated builder (see
[The `--run-build-runner` flag](#the-run-build-runner-flag) above):

```dart
final params = ImageComputedParamsBuilder()
    .proxyUrl(ProxyParams(width: 800))
    .build();
```

Models without parameterized computed fields don't get the parameter at all.
See [Computed Fields](/guides/computed-fields) for the schema side and the wire
format.

## Caveats

- **`@@paged` models are supported by the `riverpod` preset.** A paged model's list provider returns `Page<Model>`, same as the REST/RPC cases elsewhere in this guide — the generator only skips the `IList<Model>` substitution (used for unpaged list results) for a paged model's return type.
- **Update/delete controllers are single, global controllers per model, not keyed by id.** `<Model>UpdateController`/`<Model>DeleteController`'s `save`/`delete` methods take the target `id` as an argument, rather than the provider itself being a family keyed by id. Fine at small-to-medium screen scale; a screen with many concurrent in-flight updates per row might want a per-row wrapper of its own.
- **List/get providers forwarding `query`/`input` needs a live server that understands it.** The provider parameter is forwarded as-is to the underlying REST or RPC call — there's no client-side filtering fallback if the server doesn't support a given filter.
- **RPC transport has no typed query-builder class.** Unlike REST's `CratestackListQuery`, an RPC list provider's optional argument stays a raw `IMap<String, Object?>` — see [Using the riverpod preset over RPC](#using-the-riverpod-preset-over-rpc) above.

## See also

- [`cratestack-client-dart`](https://github.com/cratestack/cratestack/tree/main/crates/cratestack-client-dart) — crate source, including the `riverpod/` template directory referenced throughout this guide
- [`examples/flutter-riverpod`](https://github.com/cratestack/cratestack/tree/main/examples/flutter-riverpod) — the real, running app this guide's walkthrough is drawn from
- [TypeScript client generation](/guides/typescript-client-generation) — the sibling generator, including the additive `--swr` layout and a cross-language side-by-side comparison
- [Client Runtime](/architecture/client-runtime) — the underlying FFI bridge and codec ordering the Dart runtime is built on
- [`cratestack_cbor`](https://pub.dev/packages/cratestack_cbor) — the native codec generated clients depend on by default, and its per-release platform matrix
- [`cratestack_annotations`](https://pub.dev/packages/cratestack_annotations) — the runtime `@CratestackBuilder(...)` annotation every generated data class carries
- [`cratestack_builder`](https://pub.dev/packages/cratestack_builder) — the `build_runner` generator that expands the annotation into `{Class}Builder`
- [RPC transport](/guides/rpc-transport) — full design for `transport rpc`
