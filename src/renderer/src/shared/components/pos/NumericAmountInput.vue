<script setup lang="ts">
import { useId } from 'vue'

withDefaults(
  defineProps<{
    modelValue: string
    label: string
    disabled?: boolean
    error?: string
  }>(),
  { disabled: false, error: undefined }
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const inputId = useId()
</script>

<template>
  <div class="numeric-amount-input">
    <label :for="inputId" class="numeric-amount-input__label">{{ label }}</label>
    <input
      :id="inputId"
      class="numeric-amount-input__control numeric"
      :class="{ 'numeric-amount-input__control--error': error }"
      type="text"
      inputmode="decimal"
      :disabled="disabled"
      :value="modelValue"
      :aria-invalid="Boolean(error) || undefined"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <p v-if="error" class="numeric-amount-input__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.numeric-amount-input {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.numeric-amount-input__label {
  font-size: var(--text-body-sm-size);
  font-weight: 600;
  color: var(--color-on-surface-variant);
}

.numeric-amount-input__control {
  min-height: calc(var(--size-target-min) * 1.2);
  padding-inline: var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-outline);
  background: var(--color-surface-container-lowest);
  color: var(--color-on-surface);
  font-size: var(--text-numeric-lg-size);
  font-weight: var(--text-numeric-lg-weight);
  text-align: end;
}

.numeric-amount-input__control:disabled {
  background: var(--color-disabled-surface);
  color: var(--color-disabled-text);
}

.numeric-amount-input__control--error {
  border-color: var(--color-error);
}

.numeric-amount-input__error {
  font-size: var(--text-body-sm-size);
  color: var(--color-error);
  font-weight: 600;
}
</style>
