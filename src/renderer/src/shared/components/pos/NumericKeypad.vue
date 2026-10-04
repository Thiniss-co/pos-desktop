<script setup lang="ts">
/**
 * POS improvements, Stage 5 — on-screen numeric keypad for touch mode (tender, discount, quantity).
 * Every key is at least 56×56; it emits keys only, and the owner applies them (`applyKeypadKey`).
 */
import { KEYPAD_DIGITS, type KeypadKey } from '@renderer/shared/utils/keypad'

withDefaults(
  defineProps<{
    backspaceLabel: string
    clearLabel: string
    decimalLabel: string
    allowDecimal?: boolean
    disabled?: boolean
  }>(),
  { allowDecimal: true, disabled: false }
)

const emit = defineEmits<{ press: [KeypadKey] }>()
</script>

<template>
  <div class="numeric-keypad grid grid-cols-3 gap-2" data-testid="numeric-keypad" dir="ltr">
    <button
      v-for="digit in KEYPAD_DIGITS"
      :key="digit"
      type="button"
      class="numeric-keypad__key numeric"
      :disabled="disabled"
      :data-key="digit"
      @mousedown.prevent
      @click="emit('press', digit)"
    >
      {{ digit }}
    </button>
    <button
      type="button"
      class="numeric-keypad__key numeric"
      :disabled="disabled || !allowDecimal"
      :aria-label="decimalLabel"
      data-key="."
      @mousedown.prevent
      @click="emit('press', '.')"
    >
      .
    </button>
    <button
      type="button"
      class="numeric-keypad__key numeric"
      :disabled="disabled"
      data-key="0"
      @mousedown.prevent
      @click="emit('press', '0')"
    >
      0
    </button>
    <button
      type="button"
      class="numeric-keypad__key"
      :disabled="disabled"
      :aria-label="backspaceLabel"
      data-key="back"
      @mousedown.prevent
      @click="emit('press', 'back')"
    >
      <span aria-hidden="true">⌫</span>
    </button>
    <button
      type="button"
      class="numeric-keypad__key numeric-keypad__key--wide"
      :disabled="disabled"
      data-key="clear"
      @mousedown.prevent
      @click="emit('press', 'clear')"
    >
      {{ clearLabel }}
    </button>
  </div>
</template>

<style scoped>
.numeric-keypad__key {
  display: flex;
  min-height: 56px;
  min-width: 56px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md, 10px);
  border: 1px solid var(--color-control, currentColor);
  background: var(--color-surf, transparent);
  color: var(--color-ink, inherit);
  font-size: 1.25rem;
  font-weight: 700;
  touch-action: manipulation;
}

.numeric-keypad__key:active:not(:disabled) {
  background: var(--color-subtle, rgba(0, 0, 0, 0.06));
  transform: translateY(1px);
}

.numeric-keypad__key:disabled {
  opacity: 0.45;
}

.numeric-keypad__key--wide {
  grid-column: 1 / -1;
  font-size: 1rem;
}
</style>
