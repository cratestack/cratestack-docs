# CrateStack Docs

The human documentation for [CrateStack](https://github.com/cratestack/cratestack),
served at <https://cratestack.dev>. Built with [VitePress](https://vitepress.dev) and
the vaam-apps Material 3 theme,
[`@vaam-apps/vitepress-md3`](https://vaam-apps.github.io/vitepress-md3/).

```sh
pnpm install
pnpm docs:dev       # serve with hot reload
pnpm docs:check     # build (fails on a dead link), then check every #anchor
pnpm docs:preview   # serve the built site
```

Needs Node 22.12 or newer and pnpm.

| Path | What |
| --- | --- |
| `*.md` under `overview/`, `getting-started/`, `guides/`, … | the pages, at the repository root |
| `index.md` | the landing page |
| `.vitepress/` | config, sidebar, theme extensions |
| `public/` | static files, served as they are (`public/images/…` is `/images/…`) |
| `languages/cstack.tmLanguage.json` | the `.cstack` grammar code blocks highlight with |
| `.github/workflows/` | the pull request check and the GitHub Pages deploy |

How to write and check a page: [AGENTS.md](AGENTS.md). The framework code lives
in a separate CrateStack repository.
