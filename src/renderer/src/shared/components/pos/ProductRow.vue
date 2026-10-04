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
    :class="{ 'product-row--disabled cursor-not-allowed opacity-60': disabled }"
    @click="!disabled && emit('select')"
  >
    <span class="product-row__name min-w-0 flex-1 font-medium">{{ product.name }}</span>
    <span class="product-row__sku code text-xs text-muted">{{ product.sku }}</span>
    <StockStatus :level="product.stock" :label="stockLabel" />
    <span class="product-row__price numeric font-bold">{{ product.price }}</span>
  </AppListRow>
</template>
