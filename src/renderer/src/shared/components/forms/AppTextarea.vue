<script setup lang="ts">
import { useId } from 'vue'

withDefaults(
  defineProps<{
    modelValue: string
    label: string
    placeholder?: string
    rows?: number
    disabled?: boolean
    error?: string
    hint?: string
    maxlength?: number | string
    autofocus?: boolean
  }>(),
  {
    placeholder: undefined,
    rows: 2,
    disabled: false,
    error: undefined,
    hint: undefined,
    maxlength: undefined,
    autofocus: false
  }
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()
const fieldId = useId()
const hintId = useId()
const errorId = useId()
</script>

<template>
  <div class="app-field flex min-w-0 flex-col gap-1.5">
    <label :for="fieldId" class="app-field__label text-sm font-semibold">{{ label }}</label>
    <textarea
      :id="fieldId"
      class="app-field__control w-full resize-y rounded-md border bg-surf px-3 py-2.5 text-base text-ink disabled:bg-subtle"
      :class="error ? 'border-err' : 'border-control'"
      :value="modelValue"
      :placeholder="placeholder"
      :rows="rows"
      :disabled="disabled"
      :maxlength="maxlength"
      :data-autofocus="autofocus || undefined"
      :aria-invalid="Boolean(error) || undefined"
      :aria-describedby="
        [hint && !error ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') ||
        undefined
      "
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
    <p v-if="hint && !error" :id="hintId" class="text-xs text-muted">{{ hint }}</p>
    <p v-if="error" :id="errorId" class="text-xs font-medium text-err" role="alert">{{ error }}</p>
  </div>
</template>
