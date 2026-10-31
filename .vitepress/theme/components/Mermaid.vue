<script setup lang="ts">
// Renders one ```mermaid fence (see .vitepress/markdown.ts). Client-only:
// mermaid needs a DOM, so the server render emits the source in a <pre>,
// which keeps the page readable without JavaScript and lets search index the
// diagram's words.
import { useData } from "vitepress";
import { onMounted, ref, watch } from "vue";

const props = defineProps<{ code: string }>();
const source = decodeURIComponent(props.code);
const svg = ref("");
const failed = ref("");
const { isDark } = useData();
let seq = 0;

async function render() {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDark.value ? "dark" : "neutral",
    fontFamily: "var(--vp-font-family-base)",
    themeVariables: { fontSize: "15px" },
  });
  const id = `mmd-${Math.random().toString(36).slice(2)}-${seq++}`;
  try {
    svg.value = (await mermaid.render(id, source)).svg;
    failed.value = "";
  } catch (e) {
    // Visible, never swallowed: a diagram that silently vanishes is a page
    // that silently stops saying what it showed.
    failed.value = String(e);
    document.getElementById(`d${id}`)?.remove();
  }
}

onMounted(render);
watch(isDark, render);
</script>

<template>
  <figure class="mermaid-figure">
    <div v-if="svg" class="mermaid-svg" v-html="svg" />
    <pre v-else class="mermaid-source"><code>{{ source }}</code></pre>
    <p v-if="failed" class="mermaid-error">Diagram failed to render: {{ failed }}</p>
  </figure>
</template>
