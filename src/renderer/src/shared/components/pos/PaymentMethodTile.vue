<script setup lang="ts">
/**
 * V3 payment method tile. Eligible methods are 64px icon tiles (selected = indigo border + tint);
 * ineligible ones stay visible as dashed tiles with their reason — never hidden.
 */
import { computed } from 'vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import type { DisplayPaymentMethod, PaymentMethodKind } from './types'

const props = withDefaults(
  defineProps<{
    method: DisplayPaymentMethod
    selected?: boolean
    disabled?: boolean
    /** Visible reason under the label for an ineligible (disabled) method. */
    reason?: string
  }>(),
  { selected: false, disabled: false, reason: undefined }
)

const emit = defineEmits<{ select: [] }>()

const ICONS: Record<PaymentMethodKind, IconName> = {
  cash: 'payments',
  card: 'credit_card',
  other: 'more_horiz',
  bank_transfer: 'account_balance',
  wallet: 'account_balance_wallet',
  loyalty: 'loyalty'
}
const icon = computed(() => ICONS[props.method.kind])
</script>

<template>
  <button
    type="button"
    class="payment-method-tile flex flex-col items-center justify-center rounded-notice text-center transition-colors disabled:cursor-not-allowed"
    :class="
      disabled
        ? 'min-h-14 gap-0.5 border border-dashed border-line-strong bg-subtle p-2 text-muted'
        : [
            'h-16 gap-1 border-2 text-base font-bold',
            selected
              ? 'border-pri bg-pri-soft text-pri-text'
              : 'border-control bg-surf text-ink hover:bg-subtle'
          ]
    "
    :aria-pressed="selected"
    :disabled="disabled"
    @click="emit('select')"
  >
    <span class="flex items-center gap-1" :class="disabled ? 'text-sm font-semibold' : 'flex-col'">
      <AppIcon :name="icon" :size="disabled ? 17 : 22" />{{ method.label }}
    </span>
    <span v-if="disabled && reason" class="text-xs leading-tight">{{ reason }}</span>
  </button>
</template>
