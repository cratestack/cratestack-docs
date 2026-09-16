# Working in this repository

This is the **human-facing** documentation for
[CrateStack](https://github.com/cratestack/cratestack), built with Mintlify.
`docs.json` holds the navigation and config; content is `.md`/`.mdx` at the repo
root, grouped into Overview, Get Started, Guides, Banking Readiness,
Architecture, Tooling, Studio, Reference and Internals.

## Three repos, one surface

| Repo | Audience | Fails by |
| --- | --- | --- |
| `cratestack/cratestack` | the compiler | — |
| `cratestack/cratestack-docs` | humans (this one) | going stale |
| `cratestack/cratestack-skills` | coding agents | teaching a surface that no longer exists |

**A feature is not done until all three agree.** A framework PR that adds a
`### ` entry under `## Unreleased` must declare, in its own body, what happened
to this site and to the skills repo — enforced upstream by
`just verify-parity-declaration`.

That gate checks the **declaration**, not the parity: it reads the PR body and
cannot see this repository. Nothing automated proves this site is current.

**The reciprocal duty is this repo's.** When a change lands here that corrects a
claim about the framework — not a typo, a *claim* — check whether
`cratestack-skills` carries the same wrong claim, and say so in the PR body.
The two drift together because they document the same surface from the same
sources, and the skills repo's failure mode is the worse of the two: stale prose
misleads a human who is already reading sceptically, while a stale skill has a
coding agent emitting code against a surface that no longer exists, confidently
and at scale.

## Source wins

This site drifts, and in a specific direction: it describes what was intended or
what was true a few releases ago. **Verify against framework source, not against
the changelog narrative and not against this site's own history.** When source
and a page disagree, source is right and the page is the bug.

## Auditing for drift

The method that works, in order:

1. Read the framework `CHANGELOG.md` section headings for the releases since the
   last audit (`grep -n '^## \|^### ' CHANGELOG.md`). That is the feature
   inventory.
2. For each shipped identifier — an attribute, a flag, a macro argument — grep
   this whole site. **A zero-hit grep is the finding.**
3. For anything the changelog calls *removed*, grep for it as a **live** claim.
   Removed things linger longest: gRPC was removed in 0.8.5 and was still
   documented as a shipped third transport across a dozen files nine releases
   later, including a worked example calling a deleted API.
4. Verify every claim against **source**. Where the two have disagreed, source
   has won every time.

## Before opening a PR

```bash
mint broken-links
mint validate
```

Both are the de facto standard here; prior merged PRs quote both.

Two caveats worth knowing:

- **`mint broken-links` does not validate same-page `#anchor` links.** A bad
  anchor ships green through both commands. To check one, run `mint dev` and
  query the DOM for `[id="<anchor>"]`.
- Keep headings simple so anchors stay guessable. `## Route suppression` gives
  `#route-suppression`; adding a code span to the heading does not.

A new page needs frontmatter `title` and `description`, and must be added to the
relevant `navigation.groups[].pages` array in `docs.json` or it will not render
in the nav.

## Conventions

- Squash-merge; history reads `docs(scope): subject (#NN)`.
- Plain descriptive PR bodies — this repo has no PR template or AI-governance
  checklist requirement, unlike the framework repo.
- One automated check runs on PRs, **`Lightbridge Review`**. Read its
  *conclusion*, not just whether it finished: `SUCCESS` is clean, but `NEUTRAL`
  means **it left findings** — and the PR still reports mergeable, so a merge
  goes through with them unread. Its findings are worth checking and not worth
  trusting blindly; verify which side is wrong against source before editing
  either.
