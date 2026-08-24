<script setup lang="ts">
withDefaults(
  defineProps<{
    quantity: number
    decreaseLabel: string
    increaseLabel: string
    disabled?: boolean
    min?: number
  }>(),
  { disabled: false, min: 1 }
)

const emit = defineEmits<{ decrease: []; increase: [] }>()
</script>

<template>
  <div class="quantity-control">
    <button
      type="button"
      class="quantity-control__button"
      :aria-label="decreaseLabel"
      :disabled="disabled || quantity <= min"
      @click="emit('decrease')"
    >
      −
    </button>
    <span class="quantity-control__value numeric" aria-live="polite">{{ quantity }}</span>
    <button
      type="button"
      class="quantity-control__button"
      :aria-label="increaseLabel"
      :disabled="disabled"
      @click="emit('increase')"
    >
      +
    </button>
  </div>
</template>

<style scoped>
.quantity-control {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--color-outline);
  border-radius: var(--radius-sm);
}

.quantity-control__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--size-target-min);
  height: var(--size-target-min);
  border: none;
  background: transparent;
  color: var(--color-on-surface);
  font-size: var(--text-headline-sm-size);
  cursor: pointer;
}

.quantity-control__button:hover:not(:disabled) {
  background: var(--color-surface-container);
}

.quantity-control__button:disabled {
  color: var(--color-disabled-text);
  cursor: not-allowed;
}

.quantity-control__value {
  min-width: 2ch;
  text-align: center;
  font-size: var(--text-numeric-data-size);
  font-weight: var(--text-numeric-data-weight);
}
</style>
