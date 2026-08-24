<script setup lang="ts">
withDefaults(
  defineProps<{
    label?: string
    lines?: number
  }>(),
  { label: 'Loading', lines: 3 }
)
</script>

<template>
  <div class="app-skeleton" role="status" :aria-label="label">
    <span
      v-for="line in lines"
      :key="line"
      class="app-skeleton__line"
      :style="{ inlineSize: line === lines ? '60%' : '100%' }"
    />
  </div>
</template>

<style scoped>
.app-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.app-skeleton__line {
  display: block;
  block-size: var(--space-4);
  border-radius: var(--radius-sm);
  background: linear-gradient(
    90deg,
    var(--color-surface-container) 25%,
    var(--color-surface-container-high) 50%,
    var(--color-surface-container) 75%
  );
  background-size: 200% 100%;
  animation: app-skeleton-shimmer 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .app-skeleton__line {
    animation: none;
  }
}

@keyframes app-skeleton-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
</style>
