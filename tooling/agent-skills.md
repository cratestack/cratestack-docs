---
title: Agent Skills
description: Install CrateStack's agent skills so a coding agent works from the framework's real conventions instead of inferring them.
---

# Agent Skills

CrateStack ships a set of **agent skills** — instruction files that a coding
agent loads before it writes CrateStack code. They live in their own repository,
[`cratestack/cratestack-skills`](https://github.com/cratestack/cratestack-skills),
and install with one command.

```bash
npx skills add cratestack/cratestack-skills
```

This works with Claude Code, Cursor, OpenCode, Codex and the other agents the
`skills` CLI supports. The skills are plain `SKILL.md` files; nothing executes.

Install a subset if you prefer:

```bash
npx skills add cratestack/cratestack-skills --list
npx skills add cratestack/cratestack-skills --skill cratestack --skill cratestack-schema
```

## Why these exist

Most of what an agent needs to know about CrateStack is not inferable from the
code in front of it. That a denied model read returns **404 and not 403**, that
the embedded backend parses policies and deliberately does not enforce them, that
`@isolation` is validated and then discarded, that re-layering `DefaultBodyLimit`
on the generated router does nothing in either direction — these are conventions
and decisions, not patterns visible in a file.

Without them an agent guesses, and a plausible guess about a framework is how you
get code that compiles, passes review, and is wrong.

## What is covered

| Skill | Load it when |
| --- | --- |
| `cratestack` | Any CrateStack project — the entry point and router |
| `cratestack-schema` | Writing or debugging a `.cstack` file |
| `cratestack-server` | Building the Postgres or no-database server |
| `cratestack-policy-auth` | `@@allow` / `@@deny`, auth providers, identity |
| `cratestack-data-integrity` | Idempotency, locking, audit, soft delete, money-shaped work |
| `cratestack-embedded` | On-device SQLite: mobile, desktop, browser |
| `cratestack-clients` | Generating or consuming Rust / Dart / TypeScript SDKs |
| `cratestack-rpc` | `transport rpc`, batching, streaming, subscriptions |
| `cratestack-migrations` | Migrations, snapshots, adopting an existing database |
| `cratestack-cli` | Any `cratestack` command, or wiring one into CI |
| `cratestack-studio` | The admin and testing surface |
| `cratestack-editor-tooling` | LSP, VS Code, Neovim / Helix / Zed |
| `cratestack-troubleshooting` | A failure that isn't self-explanatory, or a green run that looks too good |
| `cratestack-contributing` | Working on the framework repo itself |

Start with `cratestack`. It picks the right facade for the crate you are in and
points at the specific skill for the task.

## They are versioned, and you should check

CrateStack is pre-1.0. Every public crate shares one version and minor releases
break, so a fact that holds for 0.12.0 can be false for the 0.9.x you are running.

Every skill therefore opens with the version it was verified against, every
release-specific fact is marked *(since X.Y.Z)*, and the repository carries a
[feature-to-release map](https://github.com/cratestack/cratestack-skills/blob/main/skills/cratestack/references/version-history.md)
— including a standing list of surfaces that are **declared but inert**, which is
the category most likely to cost you an afternoon.

Check what you are actually on:

```bash
cratestack --version
```

## How they stay current

A framework pull request that announces a user-facing change has to say what
happened to both companions — this site and the skills repo. That is enforced in
the framework repo by `just verify-parity-declaration`.

Worth reading precisely: that gate checks the **declaration**, not the parity. It
reads the pull request body and cannot see either companion repository. Keeping
the content true is a human job, and a drift audit method is written down in the
skills repo's `AGENTS.md`.

## Reporting a wrong skill

A wrong skill is worse than a missing one — a missing skill leaves an agent
appropriately unsure, while a wrong one has it writing confident, incorrect code
with the tooling vouching for it. If a skill disagrees with the framework,
**the framework is right**, and the disagreement is a bug worth
[filing](https://github.com/cratestack/cratestack-skills/issues).
