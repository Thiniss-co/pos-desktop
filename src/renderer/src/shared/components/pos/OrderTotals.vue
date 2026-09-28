<script setup lang="ts">
/**
 * V3 totals block (cart footer, payment summary, refund review): muted labels, tabular values, a
 * rule, then the bold total. Every amount arrives pre-formatted; this component never computes.
 * `#discount-action` places an "Edit" / "Add discount" control inside the discount row.
 */
withDefaults(
  defineProps<{
    subtotalLabel: string
    subtotal: string
    taxLabel: string
    tax: string
    totalLabel: string
    total: string
    discountLabel?: string
    discount?: string
    /** `lg` = the cart's 30px "Total due"; `md` = 24px; `sm` = inline summaries. */
    emphasis?: 'sm' | 'md' | 'lg'
    framed?: boolean
  }>(),
  { discountLabel: undefined, discount: undefined, emphasis: 'lg', framed: false }
)
</script>

<template>
  <dl
    class="order-totals numeric flex flex-col gap-1.5 text-sm"
    :class="{ 'rounded-lg border border-line bg-subtle px-4 py-3.5': framed }"
  >
    <div class="order-totals__row flex justify-between gap-2">
      <dt class="text-muted">{{ subtotalLabel }}</dt>
      <dd>{{ subtotal }}</dd>
    </div>
    <div
      v-if="(discountLabel && discount) || $slots['discount-action']"
      class="order-totals__row flex items-center justify-between gap-2"
    >
      <dt class="flex items-center gap-2">
        <span v-if="discountLabel && discount" class="font-semibold text-ok">{{
          discountLabel
        }}</span>
        <slot name="discount-action" />
      </dt>
      <dd v-if="discountLabel && discount" class="font-semibold text-ok">−{{ discount }}</dd>
      <dd v-else class="text-muted" aria-hidden="true">—</dd>
    </div>
    <div class="order-totals__row flex justify-between gap-2">
      <dt class="text-muted">{{ taxLabel }}</dt>
      <dd>{{ tax }}</dd>
    </div>
    <div aria-hidden="true" class="my-1 h-px bg-line" />
    <div
      class="order-totals__row order-totals__row--total flex flex-wrap items-baseline justify-between gap-2"
    >
      <dt class="font-bold" :class="emphasis === 'sm' ? 'text-sm' : 'text-md'">{{ totalLabel }}</dt>
      <dd
        class="font-extrabold whitespace-nowrap"
        :class="
          emphasis === 'lg'
            ? 'text-5xl tracking-[-0.01em]'
            : emphasis === 'md'
              ? 'text-3xl'
              : 'text-md'
        "
      >
        {{ total }}
      </dd>
    </div>
  </dl>
</template>
