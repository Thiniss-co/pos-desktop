<script setup lang="ts">
/**
 * V3 product card: pastel band with the monogram (and an in-cart quantity badge), then name
 * (2 lines), unit · SKU, price and the stock pill. There are no product photos — the catalog
 * contract has no image (IMPLEMENTATION.md D-05). Stock is information only: no stock figure or
 * reservation ever disables or dims the card, in any mode, online or offline. Only `disabled` (a
 * non-stock reason, e.g. no open shift) does.
 */
import { computed } from 'vue'
import StockStatus from './StockStatus.vue'
import type { DisplayProduct } from './types'

const props = withDefaults(
  defineProps<{
    product: DisplayProduct
    stockLabel: string
    disabled?: boolean
  }>(),
  { disabled: false }
)

const emit = defineEmits<{ select: [] }>()

const TONE_BG = ['bg-cat-0', 'bg-cat-1', 'bg-cat-2', 'bg-cat-3', 'bg-cat-4', 'bg-cat-5']
const TONE_INK = [
  'text-cat-ink-0',
  'text-cat-ink-1',
  'text-cat-ink-2',
  'text-cat-ink-3',
  'text-cat-ink-4',
  'text-cat-ink-5'
]
const tone = computed(() => (props.product.tone ?? 0) % 6)
</script>

<template>
  <div
    class="product-card-frame relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-surf"
    :class="product.inCartQuantity ? 'border-pri' : 'border-line'"
  >
    <div class="relative h-22 short:h-16" :class="TONE_BG[tone]" aria-hidden="true">
      <span
        class="absolute inset-0 flex items-center justify-center text-2xl font-bold"
        :class="TONE_INK[tone]"
        >{{ product.monogram }}</span
      >
    </div>
    <button
      type="button"
      class="product-card flex flex-1 flex-col text-start text-ink disabled:cursor-not-allowed"
      :disabled="disabled"
      :aria-label="product.ariaLabel"
      @click="emit('select')"
    >
      <span class="flex w-full flex-1 flex-col gap-0.75 px-3 pt-2.5 pb-3">
        <span
          class="product-card__name line-clamp-2 min-h-[2.7em] text-base leading-[1.35] font-medium [overflow-wrap:anywhere]"
          :title="product.name"
          >{{ product.name }}</span
        >
        <span class="flex flex-wrap gap-1.5 text-xs text-muted">
          <template v-if="product.unit"
            ><span>{{ product.unit }}</span
            ><span aria-hidden="true">·</span></template
          >
          <span class="product-card__sku code">{{ product.sku }}</span>
        </span>
        <span class="mt-auto flex flex-wrap items-center justify-between gap-1.5 pt-2">
          <span class="product-card__price numeric text-md font-bold whitespace-nowrap">{{
            product.price
          }}</span>
          <StockStatus :level="product.stock" :label="stockLabel" />
        </span>
        <span
          v-if="product.stockDetail"
          class="product-card__stock-detail text-xs text-muted [overflow-wrap:anywhere]"
          >{{ product.stockDetail }}</span
        >
      </span>
    </button>
    <span
      v-if="product.inCartQuantity"
      class="numeric pointer-events-none absolute end-2 top-2 z-2 flex h-6.5 min-w-6.5 items-center justify-center rounded-full bg-pri px-1.75 text-xs font-bold text-on-pri ring-2 ring-surf"
      aria-hidden="true"
      >{{ product.inCartQuantity }}</span
    >
  </div>
</template>
