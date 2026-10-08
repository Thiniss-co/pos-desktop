<script setup lang="ts">
/**
 * Plan §6 -- one selectable refund line. Pure presentation: pre-formatted strings and a
 * pre-computed feasibility tier in, `update:quantityMilli` out. No store, no `posApi`, no i18n --
 * every label the caller needs is passed as a prop (enforced by importBoundary.test.ts).
 *
 * V3: a table row with the − value + stepper; a selected line is tinted, a blocked line carries
 * its badge and is never selectable.
 */
import AppIcon from '../common/AppIcon.vue'
import AppStatusChip from '../feedback/AppStatusChip.vue'
import AppStepper from '../forms/AppStepper.vue'

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
    /** When set, a keypad button lets the cashier enter any quantity up to the refundable one. */
    enterQuantityLabel?: string
    disabled?: boolean
  }>(),
  { stepMilli: 1000, enterQuantityLabel: undefined, disabled: false }
)

const emit = defineEmits<{ 'update:quantityMilli': [number]; enterQuantity: [] }>()

function decrease(current: number, step: number): void {
  emit('update:quantityMilli', Math.max(0, current - step))
}

function increase(current: number, step: number, max: number): void {
  emit('update:quantityMilli', Math.min(max, current + step))
}

/** Milli-quantity → display string without trailing zeros ("1", "1.5"). Latin digits only. */
function displayQuantity(milli: number): string {
  return String(Number((milli / 1000).toFixed(3)))
}
</script>

<template>
  <tr
    class="refund-line-row"
    :class="{
      'refund-line-row--blocked': feasibilityTier !== 'ok',
      'bg-pri-soft': feasibilityTier === 'ok' && quantityMilli > 0
    }"
  >
    <td class="refund-line-row__product min-w-0">
      <div class="font-medium">{{ productName }}</div>
      <AppStatusChip
        v-if="feasibilityTier !== 'ok'"
        variant="error"
        icon="block"
        size="sm"
        class="refund-line-row__badge mt-1"
        >{{ feasibilityBadgeLabel }}</AppStatusChip
      >
    </td>
    <td class="numeric text-center">{{ quantitySoldLabel }}</td>
    <td class="numeric text-center">{{ quantityRefundedLabel }}</td>
    <td class="numeric text-center font-semibold">{{ quantityRefundableLabel }}</td>
    <td class="refund-line-row__quantity">
      <div v-if="feasibilityTier === 'ok'" class="flex items-center justify-center gap-1.5">
        <AppStepper
          width="md"
          :value="displayQuantity(quantityMilli)"
          :group-label="productName"
          :decrease-label="decreaseLabel"
          :increase-label="increaseLabel"
          :disabled="disabled"
          :decrease-disabled="quantityMilli <= 0"
          :increase-disabled="quantityMilli >= maxQuantityMilli"
          @decrease="decrease(quantityMilli, stepMilli)"
          @increase="increase(quantityMilli, stepMilli, maxQuantityMilli)"
        />
        <button
          v-if="enterQuantityLabel"
          type="button"
          class="refund-line-row__enter inline-flex size-11 items-center justify-center rounded-md border border-control text-muted hover:text-ink disabled:opacity-50"
          data-testid="refund-enter-quantity"
          :aria-label="enterQuantityLabel"
          :title="enterQuantityLabel"
          :disabled="disabled"
          @click="emit('enterQuantity')"
        >
          <AppIcon name="keyboard" :size="20" />
        </button>
      </div>
      <span v-else class="numeric block text-center text-muted">0</span>
    </td>
  </tr>
</template>
