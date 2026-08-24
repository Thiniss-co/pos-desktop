<script setup lang="ts">
withDefaults(defineProps<{ padded?: boolean }>(), { padded: true })
</script>

<template>
  <section class="app-panel" :class="{ 'app-panel--padded': padded }">
    <slot />
  </section>
</template>

<style scoped>
.app-panel {
  background: var(--color-surface-container-lowest);
  border: 1px solid var(--color-outline-variant);
  border-radius: var(--radius-lg);
}

.app-panel--padded {
  padding: var(--space-6);
}
</style>
