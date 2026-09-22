<script setup lang="ts">
/**
 * Plan §6 -- one selectable refund line. Pure presentation: pre-formatted strings and a
 * pre-computed feasibility tier in, `update:quantityMilli` out. No store, no `posApi`, no i18n --
 * every label the caller needs is passed as a prop (enforced by importBoundary.test.ts).
 */
withDefaults(
  defineProps<{
    productName: string
    quantitySoldLabel: string
    quantityRefundedLabel: string
    quantityRefundableLabel: string
    /** 'ok' | 'soft' | 'hard' -- only 'ok' lines are selectable in this release. */
    feasibilityTier: 'ok' | 'soft' | 'hard'
    feasibilityBadgeLabel: string
    quantityMilli: number
    maxQuantityMilli: number
    stepMilli?: number
    decreaseLabel: string
    increaseLabel: string
    disabled?: boolean
  }>(),
  { stepMilli: 1000, disabled: false }
)

const emit = defineEmits<{ 'update:quantityMilli': [number] }>()

function decrease(current: number, step: number): void {
  emit('update:quantityMilli', Math.max(0, current - step))
}

function increase(current: number, step: number, max: number): void {
  emit('update:quantityMilli', Math.min(max, current + step))
}
</script>

<template>
  <tr class="refund-line-row" :class="{ 'refund-line-row--blocked': feasibilityTier !== 'ok' }">
    <td class="refund-line-row__product">
      <span>{{ productName }}</span>
      <span v-if="feasibilityTier !== 'ok'" class="refund-line-row__badge label-caps">{{
        feasibilityBadgeLabel
      }}</span>
    </td>
    <td class="numeric">{{ quantitySoldLabel }}</td>
    <td class="numeric">{{ quantityRefundedLabel }}</td>
    <td class="numeric">{{ quantityRefundableLabel }}</td>
    <td class="refund-line-row__quantity">
      <div v-if="feasibilityTier === 'ok'" class="refund-line-row__control">
        <button
          type="button"
          class="refund-line-row__step"
          :aria-label="decreaseLabel"
          :disabled="disabled || quantityMilli <= 0"
          @click="decrease(quantityMilli, stepMilli)"
        >
          −
        </button>
        <span class="refund-line-row__value numeric" aria-live="polite">{{
          (quantityMilli / 1000).toFixed(3)
        }}</span>
        <button
          type="button"
          class="refund-line-row__step"
          :aria-label="increaseLabel"
          :disabled="disabled || quantityMilli >= maxQuantityMilli"
          @click="increase(quantityMilli, stepMilli, maxQuantityMilli)"
        >
          +
        </button>
      </div>
      <span v-else class="numeric">0</span>
    </td>
  </tr>
</template>

<style scoped>
.refund-line-row--blocked {
  opacity: 0.7;
}

.refund-line-row__product {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.refund-line-row__badge {
  align-self: flex-start;
  padding-inline: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-error-container);
  color: var(--color-on-error-container);
  font-size: var(--text-label-sm-size);
}

.refund-line-row__control {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.refund-line-row__step {
  width: var(--size-target-min);
  height: var(--size-target-min);
  min-width: 2.25rem;
  min-height: 2.25rem;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-outline-variant);
  background: var(--color-surface-container);
  color: var(--color-on-surface);
  font-size: var(--text-title-md-size);
  cursor: pointer;
}

.refund-line-row__step:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.refund-line-row__value {
  min-width: 3.5rem;
  text-align: center;
}
</style>
