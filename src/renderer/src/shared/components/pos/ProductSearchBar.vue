<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue: string
    label: string
    placeholder?: string
    disabled?: boolean
  }>(),
  { placeholder: undefined, disabled: false }
)

const emit = defineEmits<{ 'update:modelValue': [string]; submit: [] }>()
</script>

<template>
  <form class="product-search-bar" role="search" @submit.prevent="emit('submit')">
    <svg class="product-search-bar__icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
    <label class="product-search-bar__label" :for="'product-search-bar-input'">{{ label }}</label>
    <input
      id="product-search-bar-input"
      class="product-search-bar__input"
      type="search"
      :placeholder="placeholder"
      :disabled="disabled"
      :value="modelValue"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </form>
</template>

<style scoped>
.product-search-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--size-target-min);
  padding-inline: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-outline);
  background: var(--color-surface-container-lowest);
}

.product-search-bar__icon {
  flex: none;
  width: 18px;
  height: 18px;
  color: var(--color-on-surface-variant);
}

.product-search-bar__label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.product-search-bar__input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--color-on-surface);
  font-family: var(--font-ui);
  font-size: var(--text-body-lg-size);
}

.product-search-bar__input:disabled {
  color: var(--color-disabled-text);
}
</style>
