<script setup lang="ts">
/** Tender amount field (V3): currency prefix, 48px bold tabular input, optional label action. */
import { ref, useId } from 'vue'
import { applyKeypadKey, type KeypadKey } from '@renderer/shared/utils/keypad'
import NumericKeypad from './NumericKeypad.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    label: string
    disabled?: boolean
    error?: string
    prefix?: string
    autofocus?: boolean
    /** POS improvements, Stage 5: when set (touch mode), an on-screen keypad edits the field. */
    keypadLabels?: { backspace: string; clear: string; decimal: string } | null
    maxDecimals?: number
  }>(),
  {
    disabled: false,
    error: undefined,
    prefix: undefined,
    autofocus: false,
    keypadLabels: null,
    maxDecimals: 2
  }
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const inputId = useId()
const errorId = useId()
const inputRef = ref<HTMLInputElement | null>(null)

/** Focuses the field and selects its text, so typing replaces a pre-filled amount. */
function focus(): void {
  inputRef.value?.focus()
  inputRef.value?.select()
}

/**
 * True while the whole pre-filled amount is selected (as `focus()` and choosing a payment method
 * leave it). A typed key replaces a selection, so a keypad key must too: appending to a selected
 * "15.53" would silently drop the digits, and to a selected "20" would turn 5, 0 into "2050".
 */
function wholeValueSelected(): boolean {
  const input = inputRef.value

  return (
    input !== null &&
    props.modelValue !== '' &&
    document.activeElement === input &&
    input.selectionStart === 0 &&
    input.selectionEnd === props.modelValue.length
  )
}

function press(key: KeypadKey): void {
  const base = wholeValueSelected() ? '' : props.modelValue
  emit('update:modelValue', applyKeypadKey(base, key, props.maxDecimals))
}

defineExpose({ focus })
</script>

<template>
  <div class="numeric-amount-input flex min-w-0 flex-col gap-1.5">
    <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <label :for="inputId" class="numeric-amount-input__label text-sm font-semibold">{{
        label
      }}</label>
      <slot name="label-action" />
    </div>
    <div class="relative">
      <span
        v-if="prefix"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 start-3 flex items-center font-medium text-muted"
        >{{ prefix }}</span
      >
      <input
        :id="inputId"
        ref="inputRef"
        class="numeric-amount-input__control numeric h-12 w-full min-w-0 rounded-md border bg-surf text-[1.125rem] font-bold text-ink"
        :class="[
          { 'numeric-amount-input__control--error border-err': error, 'border-control': !error },
          prefix ? 'ps-13 pe-3' : 'px-3'
        ]"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        :disabled="disabled"
        :value="modelValue"
        :data-autofocus="autofocus || undefined"
        :aria-invalid="Boolean(error) || undefined"
        :aria-describedby="error ? errorId : undefined"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <NumericKeypad
      v-if="keypadLabels"
      class="mt-1"
      :backspace-label="keypadLabels.backspace"
      :clear-label="keypadLabels.clear"
      :decimal-label="keypadLabels.decimal"
      :allow-decimal="maxDecimals > 0"
      :disabled="disabled"
      @press="press"
    />
    <p
      v-if="error"
      :id="errorId"
      class="numeric-amount-input__error text-xs font-medium text-err"
      role="alert"
    >
      {{ error }}
    </p>
  </div>
</template>
