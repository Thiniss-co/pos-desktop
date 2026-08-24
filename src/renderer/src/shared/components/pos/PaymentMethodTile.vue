<script setup lang="ts">
import type { DisplayPaymentMethod } from './types'

withDefaults(
  defineProps<{
    method: DisplayPaymentMethod
    selected?: boolean
    disabled?: boolean
  }>(),
  { selected: false, disabled: false }
)

const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <button
    type="button"
    class="payment-method-tile"
    :aria-pressed="selected"
    :disabled="disabled"
    @click="emit('select')"
  >
    {{ method.label }}
  </button>
</template>

<style scoped>
.payment-method-tile {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(var(--size-target-min) * 1.4);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-outline);
  background: var(--color-surface-container-lowest);
  color: var(--color-on-surface);
  font-family: var(--font-ui);
  font-size: var(--text-body-lg-size);
  font-weight: 600;
  cursor: pointer;
}

.payment-method-tile:hover:not(:disabled) {
  background: var(--color-surface-container);
}

.payment-method-tile[aria-pressed='true'] {
  border-color: var(--color-transaction-accent);
  background: var(--color-transaction-container);
  color: var(--color-on-transaction-accent);
}

.payment-method-tile:disabled {
  cursor: not-allowed;
  color: var(--color-disabled-text);
}
</style>
