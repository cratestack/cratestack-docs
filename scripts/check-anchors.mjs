// Fails when a link inside the built site points at an #anchor that is not on
// the target page.
//
// VitePress's own dead-link check (on by default, `ignoreDeadLinks: false`)
// fails the build for a link to a page that does not exist, but it does not
// look at the part after `#`. This script reads the built HTML instead, so it
// sees the ids VitePress actually generated, and checks every same-site link
// that has a fragment: `#x` on the same page and `/guides/page#x` elsewhere.
//
// Usage: node scripts/check-anchors.mjs [dist]   (default .vitepress/dist)
// `pnpm docs:check` builds and then runs it.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const dist = process.argv[2] ?? ".vitepress/dist";

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "assets" ? [] : htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

// "guides/auth-provider.html" -> "/guides/auth-provider"; "index.html" -> "/".
function routeOf(file) {
  const route = `/${relative(dist, file).split(sep).join("/")}`
    .replace(/\.html$/, "")
    .replace(/\/index$/, "/");
  return route === "" ? "/" : route;
}

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// Only the page's own content, not the search index or hydration data.
function main(html) {
  const start = html.indexOf('<div id="app">');
  const end = html.lastIndexOf("<script");
  return html.slice(start < 0 ? 0 : start, end < start ? html.length : end);
}

const pages = new Map();
for (const file of htmlFiles(dist)) {
  const html = main(readFileSync(file, "utf8"));
  const ids = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => decode(m[1])));
  pages.set(routeOf(file), { file, html, ids });
}

const failures = [];
let checked = 0;
for (const [route, { html }] of pages) {
  for (const [tag, rawHref] of html.matchAll(/<a\s[^>]*?href="([^"]*#[^"]*)"[^>]*>/g)) {
    // A heading's own permalink always matches its id; it proves nothing.
    if (tag.includes('class="header-anchor"')) continue;
    const href = decode(rawHref);
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
    const [path, fragment] = href.split("#", 2);
    if (!fragment) continue;
    let target = route;
    if (path !== "") {
      // Root-relative (`/guides/x`) or relative to the page (`./../guides/x`),
      // as VitePress keeps a Markdown link the way it was written.
      const resolved = new URL(path, `https://site${route}`).pathname;
      target = resolved.replace(/\.html$/, "").replace(/\/index$/, "/") || "/";
    }
    const page = pages.get(target);
    if (!page) continue; // a missing page is VitePress's dead-link check's to report
    checked++;
    let id;
    try {
      id = decodeURIComponent(fragment);
    } catch {
      id = fragment;
    }
    if (!page.ids.has(id)) failures.push(`${route}: #${id} is not on ${target}`);
  }
}

if (failures.length) {
  console.error(`${failures.length} broken anchor link(s):`);
  for (const f of [...new Set(failures)].sort()) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`anchors: ${checked} fragment links checked across ${pages.size} pages, none broken`);
