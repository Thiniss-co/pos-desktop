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
    /**
     * POS workspace `bar`: the summary amounts on one compact line, the total due as the cart's one
     * large figure and the `#actions` slot (payment) beside it — one short band pinned under the lines.
     */
    layout?: 'stack' | 'bar'
  }>(),
  { discountLabel: undefined, discount: undefined, emphasis: 'lg', framed: false, layout: 'stack' }
)
</script>

<template>
  <!-- POS workspace band: the summary amounts read as one compact line, the total due is the one
       large figure, and the payment actions (slot) sit beside it. The grid areas adapt to the cart's
       width (workspace.css): one row on a wide cart; summary line above total + actions otherwise. -->
  <div v-if="layout === 'bar'" class="order-totals order-totals--bar numeric">
    <dl
      class="order-totals__summary flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-0.5 text-sm"
    >
      <div class="order-totals__row flex items-baseline gap-1.5 whitespace-nowrap">
        <dt class="text-xs text-muted">{{ subtotalLabel }}</dt>
        <dd>{{ subtotal }}</dd>
      </div>
      <div
        v-if="discountLabel && discount"
        class="order-totals__row flex items-baseline gap-1.5 whitespace-nowrap"
      >
        <dt class="text-xs font-semibold text-ok">{{ discountLabel }}</dt>
        <dd class="font-semibold text-ok">−{{ discount }}</dd>
      </div>
      <div class="order-totals__row flex items-baseline gap-1.5 whitespace-nowrap">
        <dt class="text-xs text-muted">{{ taxLabel }}</dt>
        <dd>{{ tax }}</dd>
      </div>
    </dl>
    <dl class="order-totals__row order-totals__row--total flex flex-col items-end">
      <dt class="text-sm font-bold">{{ totalLabel }}</dt>
      <dd
        class="leading-none font-extrabold tracking-[-0.01em] whitespace-nowrap"
        :class="emphasis === 'lg' ? 'text-4xl' : 'text-3xl'"
      >
        {{ total }}
      </dd>
    </dl>
    <div v-if="$slots.actions" class="order-totals__actions flex min-w-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
  <dl
    v-else
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
