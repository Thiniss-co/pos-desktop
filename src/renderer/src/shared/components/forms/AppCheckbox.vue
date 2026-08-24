<script setup lang="ts">
import { useId } from 'vue'

withDefaults(
  defineProps<{
    modelValue: boolean
    label: string
    disabled?: boolean
    description?: string
  }>(),
  { disabled: false, description: undefined }
)

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

const inputId = useId()
const descriptionId = useId()
</script>

<template>
  <label :for="inputId" class="app-checkbox" :class="{ 'app-checkbox--disabled': disabled }">
    <input
      :id="inputId"
      type="checkbox"
      class="app-checkbox__input"
      :checked="modelValue"
      :disabled="disabled"
      :aria-describedby="description ? descriptionId : undefined"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="app-checkbox__box" aria-hidden="true">
      <svg viewBox="0 0 16 16" class="app-checkbox__mark">
        <path
          d="M3 8.5 6.5 12 13 4.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>
    <span class="app-checkbox__text">
      <span class="app-checkbox__label">{{ label }}</span>
      <span v-if="description" :id="descriptionId" class="app-checkbox__description">
        {{ description }}
      </span>
    </span>
  </label>
</template>

<style scoped>
.app-checkbox {
  display: inline-flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-height: var(--size-target-min);
  padding-block: var(--space-1);
  cursor: pointer;
}

.app-checkbox--disabled {
  cursor: not-allowed;
  color: var(--color-disabled-text);
}

.app-checkbox__input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.app-checkbox__box {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-block-start: 2px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--color-outline);
  background: var(--color-surface-container-lowest);
  color: transparent;
  transition:
    background-color var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}

.app-checkbox__input:checked + .app-checkbox__box {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-on-primary);
}

.app-checkbox__input:focus-visible + .app-checkbox__box {
  outline: 3px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.app-checkbox--disabled .app-checkbox__box {
  background: var(--color-disabled-surface);
  border-color: var(--color-outline-variant);
}

.app-checkbox__mark {
  width: 14px;
  height: 14px;
}

.app-checkbox__text {
  display: flex;
  flex-direction: column;
}

.app-checkbox__label {
  font-size: var(--text-body-md-size);
  color: var(--color-on-surface);
}

.app-checkbox--disabled .app-checkbox__label {
  color: var(--color-disabled-text);
}

.app-checkbox__description {
  font-size: var(--text-body-sm-size);
  color: var(--color-text-muted);
}
</style>
