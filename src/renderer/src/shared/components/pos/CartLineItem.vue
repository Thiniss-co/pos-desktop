<script setup lang="ts">
import AppIconButton from '@renderer/shared/components/common/AppIconButton.vue'
import QuantityControl from './QuantityControl.vue'
import type { DisplayCartLine } from './types'

withDefaults(
  defineProps<{
    line: DisplayCartLine
    decreaseLabel: string
    increaseLabel: string
    removeLabel: string
    disabled?: boolean
  }>(),
  { disabled: false }
)

const emit = defineEmits<{ decrease: []; increase: []; remove: [] }>()
</script>

<template>
  <div class="cart-line-item">
    <div class="cart-line-item__info">
      <span class="cart-line-item__name">{{ line.name }}</span>
      <span class="cart-line-item__sku numeric">{{ line.sku }}</span>
    </div>
    <QuantityControl
      :quantity="line.quantity"
      :decrease-label="decreaseLabel"
      :increase-label="increaseLabel"
      :disabled="disabled"
      @decrease="emit('decrease')"
      @increase="emit('increase')"
    />
    <span class="cart-line-item__total numeric">{{ line.lineTotal }}</span>
    <AppIconButton
      :label="removeLabel"
      variant="danger"
      :disabled="disabled"
      @click="emit('remove')"
    >
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
.cart-line-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--size-row);
  padding-inline: var(--space-3);
  border-block-end: 1px solid var(--color-divider-subtle);
}

.cart-line-item__info {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.cart-line-item__name {
  font-weight: 600;
  color: var(--color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cart-line-item__sku {
  font-size: var(--text-body-sm-size);
  color: var(--color-text-muted);
}

.cart-line-item__total {
  min-width: 6ch;
  text-align: end;
  font-size: var(--text-numeric-data-size);
  font-weight: var(--text-numeric-data-weight);
}
</style>
