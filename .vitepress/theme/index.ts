// The vaam-apps house theme (Material 3 Expressive), extended with the few
// pieces CrateStack's pages use from Markdown.
import Md3Theme from "@vaam-apps/vitepress-md3";
import type { Theme } from "vitepress";
import LinkCard from "./components/LinkCard.vue";
import LinkCards from "./components/LinkCards.vue";
import Mermaid from "./components/Mermaid.vue";
import "./custom.css";

export default {
  extends: Md3Theme,
  enhanceApp({ app }) {
    app.component("LinkCard", LinkCard);
    app.component("LinkCards", LinkCards);
    app.component("Mermaid", Mermaid);
  },
} satisfies Theme;
