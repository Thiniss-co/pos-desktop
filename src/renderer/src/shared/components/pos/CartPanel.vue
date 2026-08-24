<script setup lang="ts">
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import type { DisplayCartLine } from './types'

withDefaults(
  defineProps<{
    lines: readonly DisplayCartLine[]
    emptyTitle: string
    emptyDescription?: string
  }>(),
  { emptyDescription: undefined }
)
</script>

<template>
  <section class="cart-panel">
    <AppEmptyState v-if="lines.length === 0" :title="emptyTitle" :description="emptyDescription" />
    <div v-else class="cart-panel__lines">
      <slot />
    </div>
    <div v-if="$slots.footer" class="cart-panel__footer">
      <slot name="footer" />
    </div>
  </section>
</template>

<style scoped>
.cart-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.cart-panel__lines {
  flex: 1;
  overflow-y: auto;
}

.cart-panel__footer {
  flex: none;
  border-block-start: 1px solid var(--color-outline-variant);
  padding: var(--space-4);
}
</style>
