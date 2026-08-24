<script setup lang="ts">
import AppListRow from '@renderer/shared/components/common/AppListRow.vue'
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
  <AppListRow
    interactive
    class="product-row"
    :class="{ 'product-row--disabled': disabled || product.stock === 'out-of-stock' }"
    @click="!(disabled || product.stock === 'out-of-stock') && emit('select')"
  >
    <span class="product-row__name">{{ product.name }}</span>
    <span class="product-row__sku numeric">{{ product.sku }}</span>
    <StockStatus :level="product.stock" :label="stockLabel" />
    <span class="product-row__price numeric">{{ product.price }}</span>
  </AppListRow>
</template>

<style scoped>
.product-row {
  justify-content: space-between;
}

.product-row--disabled {
  pointer-events: none;
  opacity: 0.6;
}

.product-row__name {
  flex: 1;
  font-weight: 600;
}

.product-row__sku {
  color: var(--color-text-muted);
  font-size: var(--text-body-sm-size);
}

.product-row__price {
  font-size: var(--text-numeric-data-size);
  font-weight: var(--text-numeric-data-weight);
}
</style>
