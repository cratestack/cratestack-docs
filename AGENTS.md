# Working in this repository

This is the **human-facing** documentation for
[CrateStack](https://github.com/cratestack/cratestack), built with
[VitePress](https://vitepress.dev) and the vaam-apps Material 3 theme,
[`@vaam-apps/vitepress-md3`](https://vaam-apps.github.io/vitepress-md3/), in its
Expressive style. `.vitepress/config.ts` holds the config and
`.vitepress/sidebar.ts` the navigation; content is `.md` at the repo root,
grouped into Overview, Get Started, Guides, Client Generation, Banking
Readiness, Architecture, Tooling, Reference, Studio and Internals. It is served
at <https://cratestack.dev> (`CNAME`) by GitHub Pages.

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

## Running the site

Node 22.12 or newer and pnpm (the version is `packageManager` in
`package.json`).

```bash
pnpm install
pnpm docs:dev       # http://localhost:5173, reloads as you edit
pnpm docs:build     # the production build, into .vitepress/dist
pnpm docs:preview   # serve that build
pnpm docs:check     # docs:build, then scripts/check-anchors.mjs
```

## Before opening a PR

```bash
pnpm docs:check
```

It must exit 0. The **`Check Docs`** workflow runs the same command on every
pull request, and **Deploy Docs** builds the same way on `main`. What it proves:

- **The build fails on a dead link** (`ignoreDeadLinks: false`): a Markdown link
  to a page that does not exist. Keep it on.
- **`scripts/check-anchors.mjs` fails on a dead `#anchor`.** VitePress checks
  that the linked page exists, not the part after `#` (nor did
  `mint broken-links`, which let bad anchors ship). The script reads the built
  HTML, so it checks against the ids VitePress really generated.
- Neither proves the prose is true. That is "Source wins", above.

Heading ids come from `.vitepress/slugify.ts`: lower case, ASCII punctuation
and spaces become `-`, an apostrophe is dropped, an em dash or arrow separates
words. `## What's not here yet` is `#whats-not-here-yet`; ``## `[target.db]` is
a direct database connection`` is `#target-db-is-a-direct-database-connection`;
an id that would start with a digit gets a leading `_`. When unsure, build and
look at the heading's `id` (or let `docs:check` tell you).

## Writing pages

- **Frontmatter `title` and `description`, and an H1.** `title` is the browser
  title and the search result; the H1 is what the page shows. A page with no
  `title` falls back to its H1.
- **A new page must be listed in `.vitepress/sidebar.ts`**, in its group, or it
  is built but not in the navigation. The sidebar `text` is rendered as HTML:
  write `<` as `&lt;` and code as `<code>…</code>`. A group of its own may need a
  `nav` entry in `.vitepress/config.ts` too.
- **Link pages without the extension**, root-relative or relative:
  `[Auth provider](/guides/auth-provider)` or `[UI](./ui#try-it-with-demo-data)`.
  `cleanUrls` serves `/guides/auth-provider` (no `.html`), the URLs the site has
  always had.
- **Images and other static files go in `public/`** and are linked from the root:
  `public/images/studio/x.png` is `/images/studio/x.png`.
- **Every page is compiled as a Vue template.** Fenced code and inline code are
  safe; in prose, `{{ … }}` is a Vue expression and `<Name>` is an element. Put
  them in backticks, write `&lt;` for a literal `<`, or wrap a block in
  `<div v-pre>`. Raw HTML is passed through unchanged, so Markdown inside an
  HTML block is not rendered: use `<code>` and `<strong>` there.
- **```` ```cstack ````** fences highlight with `languages/cstack.tmLanguage.json`
  (the grammar the editor tooling ships) and carry the teal rule of
  `.vitepress/theme/custom.css`. **```` ```mermaid ````** fences draw as
  diagrams in the browser.
- **Colours:** use the theme's tokens (`var(--md-sys-color-primary)`,
  `var(--md-sys-shape-card)`, …), never a hex value, so a rule follows light,
  dark and the Material 3 style. The seed is `themeConfig.md3.seed`.

What the Mintlify components became, for anything that still uses one:

| Mintlify | Here |
| --- | --- |
| `<Note>`, `<Info>` | `::: info` … `:::` |
| `<Tip>` | `::: tip` |
| `<Warning>` | `::: warning` |
| `<Danger>`, `<Caution>` | `::: danger` |
| `<Tabs>` of code, `<CodeGroup>` | `::: code-group` with ```` ```bash [macOS] ```` titles |
| `<Steps>` | a numbered list, or headings |
| `<Frame caption>` | `<figure>`, the image, `<figcaption>` |
| `<Columns>` of `<Card>` | `<LinkCards>` of `<LinkCard title href>` (`.vitepress/theme/components/`) |
| `<Accordion>` | `::: details Title` |

Containers, code groups, badges and the rest are VitePress's own:
[VitePress Markdown](https://vitepress.dev/guide/markdown); the theme's look of
each is on its [Markdown showcase](https://vaam-apps.github.io/vitepress-md3/guide/markdown).

## Conventions

- Squash-merge; history reads `docs(scope): subject (#NN)`.
- Plain descriptive PR bodies — this repo has no PR template or AI-governance
  checklist requirement, unlike the framework repo.
- **`Check Docs`** runs `pnpm docs:check` on every PR (see above); it is the
  build, so a red one means the site would not deploy.
- **`Lightbridge Review`** also runs on PRs. Read its
  *conclusion*, not just whether it finished: `SUCCESS` is clean, but `NEUTRAL`
  means **it left findings** — and the PR still reports mergeable, so a merge
  goes through with them unread. Its findings are worth checking and not worth
  trusting blindly; verify which side is wrong against source before editing
  either.
