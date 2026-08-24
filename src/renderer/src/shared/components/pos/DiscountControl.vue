<script setup lang="ts">
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'

withDefaults(
  defineProps<{
    modelValue: string
    label: string
    applyLabel: string
    disabled?: boolean
  }>(),
  { disabled: false }
)

const emit = defineEmits<{ 'update:modelValue': [string]; apply: [] }>()
</script>

<template>
  <form class="discount-control" @submit.prevent="emit('apply')">
    <AppInput
      :model-value="modelValue"
      :label="label"
      :disabled="disabled"
      @update:model-value="(value) => emit('update:modelValue', value)"
    />
    <AppButton type="submit" variant="secondary" :disabled="disabled">{{ applyLabel }}</AppButton>
  </form>
</template>

<style scoped>
.discount-control {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}
</style>
