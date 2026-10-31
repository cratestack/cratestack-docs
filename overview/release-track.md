---
title: Release Track
description: Current documentation track, stability expectations, and how to interpret future-facing naming.
---

# Release Track

## Active Track

The current public docs are organized as the `v0` track for CrateStack.

Use this track as:

1. the primary reference for public naming and package layout
2. the main source for future-facing examples
3. the place where current implementation boundaries are recorded honestly

## Naming Note

These docs use the public `cratestack` naming. The framework code and docs are split into separate public repositories:

1. the CrateStack workspace repository for the Rust workspace and editor package
2. the CrateStack docs repository for this Mintlify documentation project

## Stability Guide

Read sections this way:

1. `overview/` and `getting-started/` are product entrypoints
2. `guides/`, `architecture/`, and `reference/` are the main product docs
3. `internals/` captures ADRs, PRD material, and decision history that may still lead implementation

## Next Versioning Step

After the initial public release, the next natural docs move is:

1. keep `v0` as the stable baseline
2. introduce a preview or next track for unreleased changes
3. keep examples aligned with the published codebase end-to-end
