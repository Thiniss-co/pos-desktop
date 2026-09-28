<script setup lang="ts">
import type { DisplayQuickAction } from './types'

/** Large, touch-friendly quick-action tiles for the checkout column. Pure presentation. */
withDefaults(
  defineProps<{
    actions: readonly DisplayQuickAction[]
    label: string
  }>(),
  {}
)

const emit = defineEmits<{ action: [string] }>()
</script>

<template>
  <div class="quick-actions" role="toolbar" :aria-label="label">
    <button
      v-for="action in actions"
      :key="action.id"
      type="button"
      class="quick-actions__tile"
      :class="{ 'quick-actions__tile--danger': action.tone === 'danger' }"
      :data-action="action.id"
      :disabled="action.disabled"
      :aria-keyshortcuts="action.shortcut"
      :title="action.shortcut ? `${action.label} (${action.shortcut})` : action.label"
      @click="emit('action', action.id)"
    >
      <span class="quick-actions__label">{{ action.label }}</span>
      <span v-if="action.badge" class="quick-actions__badge numeric">{{ action.badge }}</span>
      <kbd v-if="action.shortcut" class="quick-actions__key">{{ action.shortcut }}</kbd>
    </button>
  </div>
</template>

<style scoped>
.quick-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-block-end: 1px solid var(--color-divider-subtle);
}

.quick-actions__tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-block-size: 3.25rem;
  padding: var(--space-2);
  border: 1px solid var(--color-outline-variant);
  border-radius: var(--radius-md);
  background: var(--color-surface-container-lowest);
  color: var(--color-on-surface);
  font-weight: 600;
  font-size: var(--text-body-sm-size);
  cursor: pointer;
}

.quick-actions__tile:hover:not(:disabled) {
  border-color: var(--color-transaction-accent);
}

.quick-actions__tile:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.quick-actions__tile:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.quick-actions__tile--danger {
  color: var(--color-error);
}

.quick-actions__badge {
  position: absolute;
  inset-block-start: -0.4rem;
  inset-inline-end: -0.4rem;
  min-inline-size: 1.3rem;
  padding-inline: 0.3rem;
  border-radius: 999px;
  background: var(--color-transaction-accent);
  color: var(--color-surface-container-lowest);
  font-size: 0.75rem;
  line-height: 1.3rem;
}

.quick-actions__key {
  color: var(--color-on-surface-variant);
  font-family: inherit;
  font-size: 0.7rem;
  font-weight: 400;
}
</style>
