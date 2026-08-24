<script setup lang="ts">
import AppIconButton from '@renderer/shared/components/common/AppIconButton.vue'
import type { DisplaySplitPayment } from './types'

withDefaults(
  defineProps<{
    payment: DisplaySplitPayment
    removeLabel: string
  }>(),
  {}
)

const emit = defineEmits<{ remove: [] }>()
</script>

<template>
  <div class="split-payment-row">
    <span class="split-payment-row__method">{{ payment.methodLabel }}</span>
    <span class="split-payment-row__amount numeric">{{ payment.amount }}</span>
    <AppIconButton :label="removeLabel" variant="danger" @click="emit('remove')">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 4l8 8M12 4l-8 8"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
    </AppIconButton>
  </div>
</template>

<style scoped>
.split-payment-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-block: var(--space-2);
  border-block-end: 1px solid var(--color-divider-subtle);
}

.split-payment-row__method {
  flex: 1;
  font-weight: 600;
}

.split-payment-row__amount {
  font-size: var(--text-numeric-data-size);
  font-weight: var(--text-numeric-data-weight);
}
</style>
