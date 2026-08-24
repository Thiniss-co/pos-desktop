<script setup lang="ts">
import { useId } from 'vue'

withDefaults(
  defineProps<{
    modelValue: string
    label: string
    type?: string
    placeholder?: string
    autocomplete?: string
    required?: boolean
    disabled?: boolean
    error?: string
    hint?: string
  }>(),
  {
    type: 'text',
    placeholder: undefined,
    autocomplete: undefined,
    required: false,
    disabled: false,
    error: undefined,
    hint: undefined
  }
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const inputId = useId()
const hintId = useId()
const errorId = useId()
</script>

<template>
  <div class="app-field">
    <label :for="inputId" class="app-field__label">
      {{ label }}<span v-if="required" class="app-field__required" aria-hidden="true"> *</span>
    </label>
    <input
      :id="inputId"
      class="app-field__control"
      :class="{ 'app-field__control--error': error }"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :required="required"
      :disabled="disabled"
      :aria-invalid="Boolean(error) || undefined"
      :aria-describedby="
        [hint && !error ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') ||
        undefined
      "
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <p v-if="hint && !error" :id="hintId" class="app-field__hint">{{ hint }}</p>
    <p v-if="error" :id="errorId" class="app-field__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.app-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  text-align: start;
}

.app-field__label {
  font-size: var(--text-body-sm-size);
  line-height: var(--text-body-sm-line);
  font-weight: 600;
  color: var(--color-on-surface-variant);
}

.app-field__required {
  color: var(--color-error);
}

.app-field__control {
  min-height: var(--size-target-min);
  padding-inline: var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-outline);
  background: var(--color-surface-container-lowest);
  color: var(--color-on-surface);
  font-family: var(--font-ui);
  font-size: var(--text-body-lg-size);
}

.app-field__control::placeholder {
  color: var(--color-text-muted);
}

.app-field__control:disabled {
  background: var(--color-disabled-surface);
  color: var(--color-disabled-text);
  cursor: not-allowed;
}

.app-field__control--error {
  border-color: var(--color-error);
}

.app-field__hint {
  font-size: var(--text-body-sm-size);
  color: var(--color-text-muted);
}

.app-field__error {
  font-size: var(--text-body-sm-size);
  color: var(--color-error);
  font-weight: 600;
}
</style>
