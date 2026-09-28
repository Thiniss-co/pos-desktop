<script setup lang="ts">
import { useId } from 'vue'
import AppIcon from '../common/AppIcon.vue'

withDefaults(
  defineProps<{
    modelValue: string
    label: string
    options: ReadonlyArray<{ value: string; label: string }>
    required?: boolean
    disabled?: boolean
    error?: string
    hint?: string
    size?: 'sm' | 'md'
    inline?: boolean
  }>(),
  { required: false, disabled: false, error: undefined, hint: undefined, size: 'md', inline: false }
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const selectId = useId()
const hintId = useId()
const errorId = useId()
</script>

<template>
  <div
    class="app-field flex min-w-0 gap-1.5"
    :class="inline ? 'flex-row items-center gap-2' : 'flex-col'"
  >
    <label
      :for="selectId"
      class="app-field__label font-semibold"
      :class="inline ? 'text-sm font-normal text-muted' : 'text-sm'"
    >
      {{ label
      }}<span v-if="required" class="app-field__required text-err" aria-hidden="true"> *</span>
    </label>
    <div class="relative">
      <select
        :id="selectId"
        class="app-field__control w-full appearance-none rounded-md border bg-surf ps-3 pe-9 text-ink disabled:cursor-not-allowed disabled:bg-subtle disabled:text-muted"
        :class="[
          error ? 'app-field__control--error border-err' : 'border-control',
          size === 'sm' ? 'h-9 text-sm' : 'h-11 text-base'
        ]"
        :required="required"
        :disabled="disabled"
        :value="modelValue"
        :aria-invalid="Boolean(error) || undefined"
        :aria-describedby="
          [hint && !error ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') ||
          undefined
        "
        @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="option in options" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <AppIcon
        name="expand_more"
        :size="20"
        class="pointer-events-none absolute inset-y-0 end-2 my-auto text-muted"
      />
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
