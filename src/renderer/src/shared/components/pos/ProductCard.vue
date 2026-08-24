<script setup lang="ts">
import StockStatus from './StockStatus.vue'
import type { DisplayProduct } from './types'

withDefaults(
  defineProps<{
    product: DisplayProduct
    stockLabel: string
    disabled?: boolean
  }>(),
  { disabled: false }
)

const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <button
    type="button"
    class="product-card"
    :disabled="disabled || product.stock === 'out-of-stock'"
    @click="emit('select')"
  >
    <span class="product-card__name">{{ product.name }}</span>
    <span class="product-card__sku numeric">{{ product.sku }}</span>
    <span class="product-card__footer">
      <span class="product-card__price numeric">{{ product.price }}</span>
      <StockStatus :level="product.stock" :label="stockLabel" />
    </span>
  </button>
</template>

<style scoped>
.product-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-height: var(--size-target-min);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-outline-variant);
  background: var(--color-surface-container-lowest);
  color: var(--color-on-surface);
  text-align: start;
  cursor: pointer;
  font-family: var(--font-ui);
}

.product-card:hover:not(:disabled) {
  border-color: var(--color-outline);
  background: var(--color-surface-container-low);
}

.product-card:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.product-card__name {
  font-size: var(--text-body-lg-size);
  font-weight: 600;
}

.product-card__sku {
  font-size: var(--text-body-sm-size);
  color: var(--color-text-muted);
}

.product-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-block-start: var(--space-2);
}

.product-card__price {
  font-size: var(--text-numeric-lg-size);
  font-weight: var(--text-numeric-lg-weight);
}
</style>
