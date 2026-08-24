<script setup lang="ts">
import { useId } from 'vue'

withDefaults(
  defineProps<{
    modelValue: string
    label: string
    options: ReadonlyArray<{ value: string; label: string }>
    required?: boolean
    disabled?: boolean
    error?: string
    hint?: string
  }>(),
  { required: false, disabled: false, error: undefined, hint: undefined }
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const selectId = useId()
const hintId = useId()
const errorId = useId()
</script>

<template>
  <div class="app-field">
    <label :for="selectId" class="app-field__label">
      {{ label }}<span v-if="required" class="app-field__required" aria-hidden="true"> *</span>
    </label>
    <select
      :id="selectId"
      class="app-field__control"
      :class="{ 'app-field__control--error': error }"
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
