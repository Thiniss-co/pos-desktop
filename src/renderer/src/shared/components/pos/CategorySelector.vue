<script setup lang="ts">
import type { DisplayCategory } from './types'

withDefaults(
  defineProps<{
    categories: readonly DisplayCategory[]
    selectedId: string | null
    allLabel: string
  }>(),
  {}
)

const emit = defineEmits<{ select: [string | null] }>()
</script>

<template>
  <div class="category-selector" role="tablist">
    <button
      type="button"
      class="category-selector__chip"
      role="tab"
      :aria-selected="selectedId === null"
      @click="emit('select', null)"
    >
      {{ allLabel }}
    </button>
    <button
      v-for="category in categories"
      :key="category.id"
      type="button"
      class="category-selector__chip"
      role="tab"
      :aria-selected="selectedId === category.id"
      @click="emit('select', category.id)"
    >
      {{ category.label }}
    </button>
  </div>
</template>

<style scoped>
.category-selector {
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  padding-block: var(--space-1);
}

.category-selector__chip {
  flex: none;
  min-height: var(--size-target-min);
  padding-inline: var(--space-4);
  border-radius: var(--radius-full);
  border: 1px solid var(--color-outline);
  background: var(--color-surface-container-lowest);
  color: var(--color-on-surface);
  font-family: var(--font-ui);
  font-size: var(--text-body-md-size);
  font-weight: 600;
  cursor: pointer;
}

.category-selector__chip:hover {
  background: var(--color-surface-container);
}

.category-selector__chip[aria-selected='true'] {
  background: var(--color-secondary-container);
  color: var(--color-on-secondary-container);
  border-color: transparent;
}
</style>
