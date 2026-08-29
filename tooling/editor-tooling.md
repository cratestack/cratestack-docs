# CrateStack Editor Tooling

This document records the current state of CrateStack editor support, how to use it locally, and the most useful follow-up work.

## Scope

CrateStack has two editor surfaces:

* Rust files that consume one of the role-specific schema macros — `cratestack::include_server_schema!(...)`, `cratestack::include_embedded_schema!(...)`, or `cratestack::include_client_schema!(...)`
* `.cstack` schema files authored directly

Those surfaces have different constraints.

Rust support depends on a real Cargo workspace because the schema macros are proc-macros that expand relative to a real schema path.

`.cstack` support is intentionally split out into a standalone language server so basic schema authoring does not require a full host project checkout.

## Current State

Implemented in this repo today:

* `crates/cratestack-lsp` provides a standalone language server for `.cstack` files (built on the actively-maintained `tower-lsp-server` 0.23 fork as of 0.3.0; the previous `tower-lsp` 0.20 dep had been unmaintained since 2024)
* `packages/cratestack-vscode` provides the VS Code extension wrapper that launches `cratestack-lsp`
* `cratestack-cli check --format json` provides machine-readable diagnostics for CI or editor fallback integrations
* parser and semantic structures now preserve schema docs and source spans needed for editor features and generated Rust docs
* the schema macros now emit Rust `#[doc = "..."]` attributes from schema-authored comments

Implemented `.cstack` editor features:

* diagnostics — **all independent errors at once**, not one per save
* hover
* completion
* go-to-definition, including enums and mixins
* find-all-references (`textDocument/references`)
* rename (F2), with `prepareRename` so the editor can refuse an invalid rename before showing the input box
* semantic tokens (`textDocument/semanticTokens/full`)
* document symbols
* document highlight
* basic syntax highlighting through the bundled TextMate grammar
* relation-aware definition lookup inside `@relation(fields:[...],references:[...])`
* narrower relation diagnostics that point at the bad relation token instead of only the whole declaration line

### Semantic tokens

The TextMate grammar cannot tell `String` (a builtin scalar), `User` (a
model), `Role` (an enum) and `Timestamps` (a mixin) apart — to a regex
they are four bare capitalised words. The server re-colours identifiers
by what they actually resolve to:

| Schema construct   | Token type   |
|--------------------|--------------|
| model              | `struct`     |
| enum               | `enum`       |
| enum variant       | `enumMember` |
| mixin              | `interface`  |
| builtin scalar     | `type`       |
| field, `@relation` column | `property` |
| procedure          | `function`   |
| procedure argument | `parameter`  |

Tokens **supplement** the grammar rather than replace it. VS Code has no
tree-sitter API for third-party languages, so the grammar keeps handling
keywords, strings and comments — available instantly, before the server
starts — and the server layers resolved identifier colouring on top.
Only an attribute's `@name` head is a decorator, so columns named inside
`@relation(fields: [...], references: [...])` keep colouring as the
properties they are.

### Features survive a syntax error

A failed parse used to drop the schema entirely, so every feature needing
one flickered off keystroke by keystroke while typing — a file spends
most of its editing life invalid. The server now retains the last schema
that parsed *together with the exact text it was parsed from*, because
spans index into the text that produced them: resolving a retained span
against the current buffer would land in the wrong place while still
looking like working navigation.

Two limits are deliberate. **Diagnostics always describe the current
text**, so a retained schema never suppresses a live error. And a
document that has never parsed keeps nothing. Because a result can now
legitimately predate what is on screen, hover marks a stale popup with a
one-line note rather than presenting it as current.

Implemented Rust-side editor improvements:

* schema `///` docs now flow into generated Rust docs and rust-analyzer hovers when proc-macro expansion is enabled
* procedure `/// @param name ...` docs now flow into generated procedure argument types

Current limitations:

* the parser still validates an initial schema subset rather than the full target grammar described across the broader docs
* Rust-side support is still project-dependent and requires real Cargo context
* the LSP does not yet implement formatting or code actions
* parsing has no error recovery, so a **syntax** error still yields exactly one diagnostic — the multi-error reporting above applies to semantic validation, where declarations are independent
* the VS Code extension prefers a bundled server binary when one is staged, but it does not yet auto-download release binaries

## Rust Setup In VS Code

For Rust consumers of the CrateStack schema macros, use `rust-analyzer` and point it at the workspace or workspaces that actually build the schema consumer.

Recommended workspace settings for this repo:

```json
{
  "rust-analyzer.linkedProjects": [
    "cratestack/Cargo.toml",
    "your-backend/Cargo.toml"
  ],
  "rust-analyzer.procMacro.enable": true,
  "rust-analyzer.cargo.buildScripts.enable": true,
  "rust-analyzer.checkOnSave": true,
  "rust-analyzer.check.allTargets": true
}
```

Why this is required:

* this repo root is not a single Cargo workspace
* generated Rust APIs come from proc-macro expansion
* the generated `cratestack_schema` module only exists when rust-analyzer can build the real consumer crate

## `.cstack` Setup In VS Code

The intended path for `.cstack` files is the `cratestack-vscode` extension plus `cratestack-lsp`.

Local development flow:

1. From `cratestack/`, build the language server with `cargo build -p cratestack-lsp`.
2. From `cratestack/packages/cratestack-vscode`, run `pnpm install` if needed.
3. Install or run the extension.
4. If the server binary is not on `PATH` and not bundled into the extension package, set `cratestack.lsp.path` to the built binary.

Supported extension settings:

* `cratestack.lsp.path`: path to the `cratestack-lsp` binary
* `cratestack.lsp.args`: extra args passed through to the server

The extension resolves the server in this order:

1. configured `cratestack.lsp.path`, if set to something other than the default `cratestack-lsp`
2. bundled binary under `server/<platform>/cratestack-lsp`
3. `cratestack-lsp` on `PATH`

## CLI Fallback And CI

For machine-readable schema validation outside the editor:

```bash
cargo run -p cratestack-cli -- check --schema path/to/schema.cstack --format json
```

This is useful for:

* CI validation
* fallback editor integrations outside VS Code
* smoke-testing parser and semantic diagnostics without starting the LSP

## Schema Docs And Generated Rust Docs

Schema-authored comments now serve both schema authors and Rust consumers.

Supported today:

* leading `///` comments on declarations and fields
* `/// @param name ...` docs for procedure arguments
* proc-macro emission of Rust `#[doc = "..."]` attributes for generated models, fields, inputs, and procedure modules

This keeps one documentation source for:

* `.cstack` authors reading schemas
* Rust users reading generated API docs and hovers
* future richer hover content in the `.cstack` language server

## Packaging And Release Flow

The current extension packaging model is intentionally thin.

`cratestack-vscode` contributes the language registration and launches `cratestack-lsp`; the heavy logic stays in the Rust binary.

Current release flow:

1. Build the release server with `cargo build --release -p cratestack-lsp`.
2. Stage the binary into `packages/cratestack-vscode/server/<platform>/` with `pnpm run stage-server`.
3. Package the extension with `pnpm run package:vsix`.

The VSIX packaging step uses `vsce --no-dependencies` because the extension ships a small JavaScript wrapper plus the staged server binary rather than relying on npm dependency scanning to decide runtime contents.

Listing metadata is in place: alongside `.vscodeignore`, `license`, and `repository`, `package.json` declares an `icon` (`packages/cratestack-vscode/icon.png`, a 256×256 PNG) and a matching `galleryBanner`. Neither the Marketplace nor Open VSX requires an icon to accept a publish, so without one both listings — and the in-editor Extensions sidebar after a manual VSIX install — fall back to a generic placeholder. The field is platform-independent, so every per-target VSIX carries it without extra work.

## Verification In Repo

Covered today:

* parser tests for docs, spans, and related regressions
* LSP tests for hover, definitions, symbols, and relation diagnostics
* extension package tests for server path resolution
* VS Code extension-host smoke tests for activation and bundled server launch
* Rust workspace tests for the underlying crates

This gives reasonable confidence that the current editor stack works end to end, including packaged extension behavior.

## Future Improvements

Highest-value follow-up work:

1. Add code actions for common relation mistakes, especially missing `fields` / `references` targets and simple typo recovery.
2. Add formatting (`textDocument/formatting`) for `.cstack` files.
3. Add stronger extension-host end-to-end tests that assert definition, hover, and diagnostics through the actual VS Code APIs.

Semantic tokens, rename and find-references were on this list and have
since shipped — see [Current State](#current-state). So has the marketplace
icon — see [Packaging And Release Flow](#packaging-and-release-flow).

Likely medium-term work:

1. Extend the parser and semantic model toward the full target grammar described in the broader PRD and ADR docs.
2. Add richer relation-aware validation so relation diagnostics can reason about more mismatches before code generation.
3. Expose more stable editor-oriented library surfaces from parser and semantic crates instead of keeping some logic narrowly embedded in the current LSP layer.
4. Improve multi-platform release packaging so extension artifacts can be produced and verified more systematically across supported targets.
5. Add non-VS-Code editor integration paths using the standalone `cratestack-lsp` binary.

Deferred or optional follow-ups:

1. Formatting support for `.cstack` once the schema grammar and style expectations stabilize.
2. Auto-download or release-channel discovery for `cratestack-lsp` binaries instead of requiring either a bundled server or manual path setup.
3. More workspace-aware Rust and schema cross-navigation if future architecture needs symbol links between generated Rust surfaces and original schema declarations.
