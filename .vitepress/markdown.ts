import type { MarkdownRenderer } from "vitepress";

/**
 * ```mermaid fences become <Mermaid>, rendered on the client (mermaid needs a
 * DOM) and again when the reader toggles dark mode. Mintlify drew these
 * natively; VitePress does not. The same approach as vpay-docs, a vaam-apps
 * sibling site.
 */
export function cratestackMarkdown(md: MarkdownRenderer) {
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    if (token.info.trim() === "mermaid") {
      return `<Mermaid code="${encodeURIComponent(token.content)}" />`;
    }
    return fence(tokens, idx, options, env, self);
  };
}
