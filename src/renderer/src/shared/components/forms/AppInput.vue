<script setup lang="ts">
/**
 * Labelled V3 text field: visible 14px semibold label, 44px control, helper or error text below.
 * `prefix` renders a fixed adornment at the inline start (e.g. the currency code); `code` switches
 * to JetBrains Mono and forces LTR for identifiers (company code, tax id, references).
 */
import { ref, useId } from 'vue'

withDefaults(
  defineProps<{
    modelValue: string
    label: string
    type?: string
    placeholder?: string
    autocomplete?: string
    required?: boolean
    disabled?: boolean
    readonly?: boolean
    error?: string
    hint?: string
    prefix?: string
    code?: boolean
    dir?: 'ltr' | 'rtl' | 'auto'
    inputmode?: 'text' | 'decimal' | 'numeric' | 'email' | 'tel' | 'search'
    size?: 'md' | 'lg'
    autofocus?: boolean
    maxlength?: number | string
    minlength?: number | string
    hideLabel?: boolean
  }>(),
  {
    type: 'text',
    placeholder: undefined,
    autocomplete: undefined,
    required: false,
    disabled: false,
    readonly: false,
    error: undefined,
    hint: undefined,
    prefix: undefined,
    code: false,
    dir: undefined,
    inputmode: undefined,
    size: 'md',
    autofocus: false,
    maxlength: undefined,
    minlength: undefined,
    hideLabel: false
  }
)

const emit = defineEmits<{
  'update:modelValue': [string]
  blur: [FocusEvent]
  keydown: [KeyboardEvent]
}>()

const inputId = useId()
const hintId = useId()
const errorId = useId()
const inputRef = ref<HTMLInputElement | null>(null)

defineExpose({
  focus: () => inputRef.value?.focus(),
  select: () => inputRef.value?.select()
})
</script>

<template>
  <div class="app-field flex min-w-0 flex-col gap-1.5">
    <label
      :for="inputId"
      class="app-field__label text-sm font-semibold"
      :class="{ 'sr-only': hideLabel }"
    >
      {{ label
      }}<span v-if="required" class="app-field__required text-err" aria-hidden="true"> *</span>
    </label>
    <div class="relative">
      <span
        v-if="prefix"
        class="pointer-events-none absolute inset-y-0 start-3 flex items-center font-medium text-muted"
        aria-hidden="true"
        >{{ prefix }}</span
      >
      <input
        :id="inputId"
        ref="inputRef"
        class="app-field__control w-full rounded-md border bg-surf text-ink transition-colors disabled:cursor-not-allowed disabled:bg-subtle disabled:text-muted read-only:bg-subtle"
        :class="[
          error ? 'app-field__control--error border-err' : 'border-control',
          size === 'lg' ? 'h-12 text-[1.125rem] font-bold' : 'h-11 text-base',
          prefix ? 'ps-13 pe-3' : 'px-3',
          { 'code text-start': code, numeric: inputmode === 'decimal' || inputmode === 'numeric' }
        ]"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :autocomplete="autocomplete"
        :required="required"
        :disabled="disabled"
        :readonly="readonly"
        :dir="code ? 'ltr' : dir"
        :inputmode="inputmode"
        :maxlength="maxlength"
        :minlength="minlength"
        :data-autofocus="autofocus || undefined"
        :aria-invalid="Boolean(error) || undefined"
        :aria-describedby="
          [hint && !error ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') ||
          undefined
        "
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        @blur="emit('blur', $event)"
        @keydown="emit('keydown', $event)"
      />
      <slot name="end" />
    </div>
    <p v-if="hint && !error" :id="hintId" class="app-field__hint text-xs text-muted">{{ hint }}</p>
    <p
      v-if="error"
      :id="errorId"
      class="app-field__error text-xs font-medium text-err"
      role="alert"
    >
      {{ error }}
    </p>
  </div>
</template>
