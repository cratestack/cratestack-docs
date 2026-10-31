<script setup lang="ts">
// A grid of <LinkCard>s; what Mintlify's <Columns> of <Card>s was.
</script>

<template>
  <div class="link-cards">
    <slot />
  </div>
</template>

<style scoped>
.link-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
  gap: 16px;
  margin: 24px 0;
}
</style>
