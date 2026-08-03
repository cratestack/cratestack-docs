---
title: Installing the CLI
description: Install cratestack-cli without a Rust toolchain, via cargo-binstall, npm, or from source.
---

# Installing The CLI

`cratestack-cli` (the `cratestack` binary) validates `.cstack` schemas and generates Dart/TypeScript
clients and the Studio scaffold. Prebuilt binaries are published for macOS (x64, arm64), Linux
(x64, arm64), and Windows (x64) on every tagged release — most consumers do not need a Rust
toolchain to install it.

## `cargo-binstall` (recommended for Rust users)

If you already have [`cargo-binstall`](https://github.com/cargo-bins/cargo-binstall) installed:

```bash
cargo binstall cratestack-cli
```

This resolves the prebuilt binary for your platform from the project's GitHub Releases and installs
it to `~/.cargo/bin` — no `rustc`/`cargo build` invocation. Dry-run to confirm resolution without
installing:

```bash
cargo binstall cratestack-cli --dry-run
```

## npm

For TypeScript/JavaScript-only workflows (no Rust toolchain, no `cargo-binstall`):

```bash
npm install --global @cratestack/cli
```

Or run without installing:

```bash
npx @cratestack/cli --help
```

`@cratestack/cli`'s `postinstall` step downloads the matching platform binary from GitHub Releases
and verifies its checksum, the same model `esbuild` and `@biomejs/biome` use. See the
[package README](https://github.com/cratestack/cratestack/tree/main/packages/cratestack-cli-npm) for
supported environment variables (`CRATESTACK_CLI_SKIP_DOWNLOAD`, `CRATESTACK_CLI_BINARY_PATH`) for
offline or vendored installs.

## From source

With a Rust toolchain installed:

```bash
cargo install cratestack-cli
```

Or, working inside the `cratestack` workspace:

```bash
cargo run -p cratestack-cli -- --help
```

## GitHub Actions

For CI workflows, the `install-cratestack-cli` composite action downloads a prebuilt binary, verifies
its checksum, and adds it to `PATH` — no Rust toolchain step needed in the job:

```yaml
- uses: cratestack/cratestack/.github/actions/install-cratestack-cli@main
  with:
    version: "0.6.7" # optional, defaults to "latest"
- run: cratestack --help
```

See the action's [README](https://github.com/cratestack/cratestack/tree/main/.github/actions/install-cratestack-cli)
for its full inputs/outputs. Pin `@main` to a released tag or commit SHA for reproducible CI.

## Supported platforms

| OS      | Architecture | Target triple                 |
| ------- | ------------ | ------------------------------ |
| macOS   | x64          | `x86_64-apple-darwin`          |
| macOS   | arm64        | `aarch64-apple-darwin`         |
| Linux   | x64          | `x86_64-unknown-linux-gnu`     |
| Linux   | arm64        | `aarch64-unknown-linux-gnu`    |
| Windows | x64          | `x86_64-pc-windows-msvc`       |

A platform outside this table (e.g. Windows arm64, Linux musl) has no prebuilt binary yet — install
from source instead. See [issue #131](https://github.com/cratestack/cratestack/issues/131) for the
distribution pipeline this page describes, and open a new issue if you need another target.

## How releases are built

Releases are cut through an automated, PR-based flow: the "Prepare Release" workflow bumps the
version, opens a release PR, and merging that PR triggers the "Cut Release Tag" workflow to push the
`vX.Y.Z` tag. That tag push runs `.github/workflows/release-cli.yml`, which cross-compiles
`cratestack-cli` for every target above, packages each as `cratestack-cli-<target>-v<version>.{tar.gz,zip}`
with a `.sha256` checksum, and attaches them to the tag's GitHub Release. `cargo-binstall` resolution
and the npm installer both depend on that exact naming — see
[`[package.metadata.binstall]`](https://github.com/cratestack/cratestack/blob/main/crates/cratestack-cli/Cargo.toml)
in `cratestack-cli`'s `Cargo.toml`.

`just release VERSION PUSH=1` remains available as a local/manual fallback that produces the same
tag push, for when the automated PR flow isn't usable.

Version numbers stay in sync automatically: `just bump` rewrites both the workspace `Cargo.toml`
versions and the npm package's `version` field from the same source, so a crates.io publish, a
GitHub Release, and an npm publish for a given version all ship the same binary.
