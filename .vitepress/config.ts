import { readFileSync } from "node:fs";
import { defineMd3Config } from "@vaam-apps/vitepress-md3/config";
import { cratestackMarkdown } from "./markdown.ts";
import { sidebar } from "./sidebar.ts";
import { slugify } from "./slugify.ts";

// The `.cstack` grammar, the same TextMate file the editor tooling ships. Shiki
// loads it by its `name`, so ```cstack fences highlight.
const cstack = JSON.parse(
  readFileSync(new URL("../languages/cstack.tmLanguage.json", import.meta.url), "utf8"),
);

// Served at the root of the custom domain in CNAME, which the Pages workflow
// copies into the build. Set DOCS_BASE=/cratestack-docs/ to preview the
// github.io project path instead. `||`, not `??`: an empty DOCS_BASE means the
// default, never a base of "".
const hostname = "https://cratestack.dev";
const base = process.env.DOCS_BASE || "/";
const repo = "https://github.com/cratestack/cratestack-docs";

// The vaam-apps house theme, Material 3 Expressive (@vaam-apps/vitepress-md3).
// Every colour on the site is generated from `themeConfig.md3`, in light and
// dark; .vitepress/theme/custom.css uses those tokens, not colours of its own.
export default defineMd3Config({
  base,
  lang: "en",
  title: "CrateStack",
  titleTemplate: ":title · CrateStack",
  description:
    "Build typed services from one schema — server-side Postgres, embedded SQLite, or HTTP client — with generated delegates, routes, policy checks, and clients.",
  // The pages live at the repository root, next to files that are not pages.
  srcExclude: ["README.md", "AGENTS.md", "CLAUDE.md"],
  // `/guides/auth-provider`, not `/guides/auth-provider.html`: the URLs the
  // Mintlify site had, so links from elsewhere keep working.
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname },
  // A link to a page that does not exist fails the build.
  ignoreDeadLinks: false,
  head: [
    [
      "link",
      {
        rel: "icon",
        type: "image/svg+xml",
        href: `${base}images/branding/cratestack-app-icon.svg`,
      },
    ],
  ],

  markdown: {
    languages: [cstack],
    // No Shiki grammar exists for CDDL (RFC 8610); its fences render as plain
    // text, as they did before, without a warning per block.
    languageAlias: { cddl: "txt" },
    // Heading ids; see slugify.ts.
    anchor: { slugify },
    headers: { slugify },
    config: cratestackMarkdown,
  },

  // mermaid is the one large dependency, and Mermaid.vue imports it
  // dynamically, so its chunks load only on a page that draws a diagram.
  vite: { build: { chunkSizeWarningLimit: 2500 } },

  themeConfig: {
    md3: {
      style: "expressive",
      seed: "#0f766e",
    },

    logo: "/images/branding/cratestack-logomark.svg",
    siteTitle: "CrateStack",

    // The three tabs of the Mintlify site.
    nav: [
      {
        text: "Documentation",
        link: "/getting-started/quickstart",
        activeMatch: "^/(overview|getting-started|guides|architecture|tooling|reference)/",
      },
      { text: "Studio", link: "/studio/quickstart", activeMatch: "^/studio/" },
      {
        text: "Internals",
        link: "/internals/core-architecture-adr",
        activeMatch: "^/internals/",
      },
    ],

    sidebar,

    outline: [2, 3],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/cratestack/cratestack" }],
    editLink: {
      pattern: `${repo}/edit/main/:path`,
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 Stephane Segning",
    },
  },
});
