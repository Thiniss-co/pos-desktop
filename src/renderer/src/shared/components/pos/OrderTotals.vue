<script setup lang="ts">
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
  }>(),
  { discountLabel: undefined, discount: undefined }
)
</script>

<template>
  <dl class="order-totals">
    <div class="order-totals__row">
      <dt>{{ subtotalLabel }}</dt>
      <dd class="numeric">{{ subtotal }}</dd>
    </div>
    <div v-if="discountLabel && discount" class="order-totals__row">
      <dt>{{ discountLabel }}</dt>
      <dd class="numeric">−{{ discount }}</dd>
    </div>
    <div class="order-totals__row">
      <dt>{{ taxLabel }}</dt>
      <dd class="numeric">{{ tax }}</dd>
    </div>
    <div class="order-totals__row order-totals__row--total">
      <dt>{{ totalLabel }}</dt>
      <dd class="numeric">{{ total }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.order-totals {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.order-totals__row {
  display: flex;
  justify-content: space-between;
  font-size: var(--text-body-md-size);
  color: var(--color-on-surface-variant);
}

.order-totals__row--total {
  padding-block-start: var(--space-2);
  margin-block-start: var(--space-1);
  border-block-start: 1px solid var(--color-outline-variant);
  font-size: var(--text-numeric-lg-size);
  font-weight: var(--text-numeric-lg-weight);
  color: var(--color-on-surface);
}
</style>
