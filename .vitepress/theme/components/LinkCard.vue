<script setup lang="ts">
// One linked card: a title and a sentence or two. Mintlify's <Card>, in the
// theme's tokens, so it follows light, dark and the Material 3 style.
import { withBase } from "vitepress";
import { computed } from "vue";

const props = defineProps<{ title: string; href: string }>();
const external = computed(() => /^https?:\/\//.test(props.href));
const url = computed(() => (external.value ? props.href : withBase(props.href)));
</script>

<template>
  <a
    class="link-card"
    :href="url"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noreferrer' : undefined"
  >
    <span class="title">{{ title }}</span>
    <span class="body"><slot /></span>
  </a>
</template>

<style scoped>
.link-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  padding: 20px 22px;
  border-radius: var(--md-sys-shape-card);
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  color: var(--md-sys-color-on-surface);
  text-decoration: none;
  transition:
    background-color 0.2s,
    border-color 0.2s,
    transform var(--md-sys-motion-spring-spatial-default-duration)
      var(--md-sys-motion-spring-spatial-default);
}

.link-card:hover {
  background: var(--md-sys-color-surface-container);
  border-color: var(--md-sys-color-primary);
}

.link-card:active {
  transform: scale(0.98);
}

.title {
  font-weight: 600;
  color: var(--md-sys-color-primary);
}

.body {
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--md-sys-color-on-surface-variant);
}

.body :deep(p) {
  margin: 0;
}
</style>
