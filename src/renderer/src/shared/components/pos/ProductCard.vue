<script setup lang="ts">
/**
 * V3 product card: the product image or the pastel band with the monogram (and an in-cart quantity
 * badge), then name (2 lines), unit · SKU, price and the stock pill. D-05 (revised, owner UX plan
 * P8): the card shows the product image when the server delivered one and its bytes were verified
 * locally; otherwise — and when the image fails to draw — the pastel monogram band, in the same box,
 * so nothing shifts. Stock is information only: no stock figure or
 * reservation ever disables or dims the card, in any mode, online or offline. Only `disabled` (a
 * non-stock reason, e.g. no open shift) does.
 */
import { computed, ref, watch } from 'vue'
import StockStatus from './StockStatus.vue'
import type { DisplayProduct } from './types'

const props = withDefaults(
  defineProps<{
    product: DisplayProduct
    stockLabel: string
    disabled?: boolean
    /**
     * POS workspace compact browsing: no image band; name, price and the stock pill only, with the
     * in-cart badge. Stock stays information only, exactly as on the full card.
     */
    compact?: boolean
  }>(),
  { disabled: false, compact: false }
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
const imageFailed = ref(false)
watch(
  () => props.product.imageUrl,
  () => (imageFailed.value = false)
)
const showImage = computed(() => Boolean(props.product.imageUrl) && !imageFailed.value)
</script>

<template>
  <div
    class="product-card-frame relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-surf"
    :class="product.inCartQuantity ? 'border-pri' : 'border-line'"
  >
    <div
      v-if="!compact"
      class="relative h-22 short:h-16"
      :class="showImage ? 'bg-surf' : TONE_BG[tone]"
      aria-hidden="true"
    >
      <img
        v-if="showImage"
        :src="product.imageUrl"
        alt=""
        class="absolute inset-0 h-full w-full object-contain"
        decoding="async"
        data-testid="product-card-image"
        @error="imageFailed = true"
      />
      <span
        v-else
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
      <span
        class="flex w-full flex-1 flex-col"
        :class="compact ? 'gap-0.5 ps-2.5 pe-8 pt-2 pb-2' : 'gap-0.75 px-3 pt-2.5 pb-3'"
      >
        <span
          class="product-card__name line-clamp-2 leading-[1.35] font-medium [overflow-wrap:anywhere]"
          :class="compact ? 'min-h-[2.7em] text-sm' : 'min-h-[2.7em] text-base'"
          :title="product.name"
          >{{ product.name }}</span
        >
        <span v-if="!compact" class="flex flex-wrap gap-1.5 text-xs text-muted">
          <template v-if="product.unit"
            ><span>{{ product.unit }}</span
            ><span aria-hidden="true">·</span></template
          >
          <span class="product-card__sku code">{{ product.sku }}</span>
        </span>
        <span
          class="mt-auto flex gap-1.5"
          :class="
            compact ? 'flex-col items-start pt-1' : 'flex-wrap items-center justify-between pt-2'
          "
        >
          <span
            class="product-card__price numeric font-bold whitespace-nowrap"
            :class="compact ? 'text-sm' : 'text-md'"
            >{{ product.price }}</span
          >
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
