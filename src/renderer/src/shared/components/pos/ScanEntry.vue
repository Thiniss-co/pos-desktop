<script setup lang="ts">
import { ref } from 'vue'
import type { DisplayScanResult } from './types'

/**
 * The till's direct add-to-cart field. It is deliberately NOT a search box: it never filters the
 * catalog grid, it resolves exactly one code on Enter and adds it straight to the draft. A
 * keyboard-wedge scanner typing into it is handled here (the page-level scanner listener ignores
 * focused inputs), and a scan made while it is not focused still lands via the page listener.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    label: string
    placeholder: string
    hint: string
    multiplierLabel: string
    multipliers?: readonly number[]
    pendingMultiplier: number | null
    clearMultiplierLabel: string
    result: DisplayScanResult | null
    disabled?: boolean
  }>(),
  { multipliers: () => [2, 3, 5, 10], disabled: false }
)

const emit = defineEmits<{
  'update:modelValue': [string]
  submit: [string]
  setMultiplier: [number | null]
}>()

const inputRef = ref<HTMLInputElement | null>(null)

function submit(): void {
  if (props.disabled) {
    return
  }

  emit('submit', props.modelValue)
}

defineExpose({ focus: () => inputRef.value?.focus() })
</script>

<template>
  <section class="scan-entry" :class="{ 'scan-entry--disabled': disabled }">
    <form class="scan-entry__form" @submit.prevent="submit">
      <label class="scan-entry__label" for="scan-entry-input">
        <svg class="scan-entry__icon" viewBox="0 0 24 16" aria-hidden="true">
          <path
            d="M1 1v14M4 1v14M6 1v14M9 1v14M13 1v14M15 1v14M18 1v14M20 1v14M23 1v14"
            stroke="currentColor"
            stroke-width="1.4"
          />
        </svg>
        <span>{{ label }}</span>
      </label>
      <div class="scan-entry__field">
        <span
          v-if="pendingMultiplier !== null"
          class="scan-entry__pending numeric"
          data-testid="scan-entry-pending"
        >
          ×{{ pendingMultiplier }}
        </span>
        <input
          id="scan-entry-input"
          ref="inputRef"
          class="scan-entry__input numeric"
          type="text"
          inputmode="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="placeholder"
          :disabled="disabled"
          :value="modelValue"
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
          @keydown.esc.prevent="emit('update:modelValue', '')"
        />
      </div>
    </form>

    <div class="scan-entry__multipliers" role="group" :aria-label="multiplierLabel">
      <span class="scan-entry__multiplier-label">{{ multiplierLabel }}</span>
      <button
        v-for="value in multipliers"
        :key="value"
        type="button"
        class="scan-entry__multiplier numeric"
        :class="{ 'scan-entry__multiplier--active': pendingMultiplier === value }"
        :aria-pressed="pendingMultiplier === value ? 'true' : 'false'"
        :disabled="disabled"
        @click="emit('setMultiplier', pendingMultiplier === value ? null : value)"
      >
        ×{{ value }}
      </button>
      <button
        v-if="pendingMultiplier !== null"
        type="button"
        class="scan-entry__multiplier scan-entry__multiplier--clear"
        :disabled="disabled"
        @click="emit('setMultiplier', null)"
      >
        {{ clearMultiplierLabel }}
      </button>
    </div>

    <div
      v-if="result"
      :key="result.sequence"
      class="scan-entry__result"
      :class="`scan-entry__result--${result.tone}`"
      role="status"
      aria-live="polite"
    >
      <span class="scan-entry__result-code numeric">{{ result.code }}</span>
      <span class="scan-entry__result-message">{{ result.message }}</span>
      <span v-if="result.detail" class="scan-entry__result-detail numeric">{{
        result.detail
      }}</span>
    </div>
    <p v-else class="scan-entry__hint">{{ hint }}</p>
  </section>
</template>

<style scoped>
.scan-entry {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-block-end: 1px solid var(--color-divider-subtle);
  background: var(--color-surface-container);
}

.scan-entry__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.scan-entry__label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-on-surface-variant);
  font-size: var(--text-label-caps-size);
  font-weight: var(--text-label-caps-weight);
  letter-spacing: var(--text-label-caps-tracking);
  text-transform: uppercase;
}

html[dir='rtl'] .scan-entry__label {
  text-transform: none;
}

.scan-entry__icon {
  inline-size: 1.5rem;
  block-size: 1rem;
  color: var(--color-transaction-accent);
}

.scan-entry__field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-block-size: calc(var(--size-target-min) * 1.25);
  padding-inline: var(--space-3);
  border: 2px solid var(--color-transaction-accent);
  border-radius: var(--radius-md);
  background: var(--color-surface-container-lowest);
}

.scan-entry__field:focus-within {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.scan-entry__pending {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-transaction-accent);
  color: var(--color-surface-container-lowest);
  font-weight: 700;
}

.scan-entry__input {
  flex: 1;
  min-inline-size: 0;
  border: none;
  background: transparent;
  color: var(--color-on-surface);
  font-size: var(--text-numeric-lg-size);
  font-weight: var(--text-numeric-lg-weight);
  letter-spacing: 0.04em;
}

.scan-entry__input:focus {
  outline: none;
}

.scan-entry__multipliers {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.scan-entry__multiplier-label {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
}

.scan-entry__multiplier {
  min-inline-size: 2.75rem;
  min-block-size: 2.25rem;
  padding-inline: var(--space-2);
  border: 1px solid var(--color-outline);
  border-radius: var(--radius-sm);
  background: var(--color-surface-container-lowest);
  color: var(--color-on-surface);
  font-weight: 600;
  cursor: pointer;
}

.scan-entry__multiplier--active {
  border-color: var(--color-transaction-accent);
  background: var(--color-transaction-accent);
  color: var(--color-surface-container-lowest);
}

.scan-entry__multiplier--clear {
  font-weight: 400;
}

.scan-entry__multiplier:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.scan-entry__result {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0 var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border-inline-start: 4px solid currentColor;
  font-size: var(--text-body-sm-size);
  animation: scan-entry-flash 0.45s ease-out;
}

.scan-entry__result--success {
  background: var(--color-success-container);
  color: var(--color-on-success-container);
}

.scan-entry__result--warning {
  background: var(--color-warning-container);
  color: var(--color-on-warning-container);
}

.scan-entry__result--error {
  background: var(--color-error-container);
  color: var(--color-on-error-container);
}

.scan-entry__result-code {
  font-weight: 700;
}

.scan-entry__result-detail {
  grid-column: 1 / -1;
  font-weight: 600;
}

.scan-entry__hint {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
}

.scan-entry--disabled .scan-entry__field {
  border-color: var(--color-outline-variant);
}

@keyframes scan-entry-flash {
  from {
    transform: scale(0.98);
    opacity: 0.4;
  }

  to {
    transform: scale(1);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .scan-entry__result {
    animation: none;
  }
}
</style>
