<script setup lang="ts">
/** Tender amount field (V3): currency prefix, 48px bold tabular input, optional label action. */
import { ref, useId } from 'vue'

withDefaults(
  defineProps<{
    modelValue: string
    label: string
    disabled?: boolean
    error?: string
    prefix?: string
    autofocus?: boolean
  }>(),
  { disabled: false, error: undefined, prefix: undefined, autofocus: false }
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
