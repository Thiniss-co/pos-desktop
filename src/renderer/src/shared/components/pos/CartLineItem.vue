<script setup lang="ts">
/**
 * V3 cart line: the name wraps (never truncated), remove at the inline end; beneath, the unit
 * price, the stepper and the line amount. Amounts arrive pre-computed and pre-formatted.
 */
import AppIconButton from '@renderer/shared/components/common/AppIconButton.vue'
import QuantityControl from './QuantityControl.vue'
import type { DisplayCartLine } from './types'

withDefaults(
  defineProps<{
    line: DisplayCartLine
    decreaseLabel: string
    increaseLabel: string
    removeLabel: string
    quantityLabel?: string
    disabled?: boolean
  }>(),
  { quantityLabel: undefined, disabled: false }
)

const emit = defineEmits<{ decrease: []; increase: []; remove: [] }>()
</script>

<template>
  <div
    class="cart-line-item grid grid-cols-[minmax(0,1fr)_auto_minmax(84px,auto)] items-center gap-x-2.5 gap-y-1 border-b border-line py-3"
  >
    <div class="cart-line-item__info col-span-2 min-w-0">
      <span
        class="cart-line-item__name block text-base leading-[1.35] font-medium [overflow-wrap:anywhere]"
        >{{ line.name }}</span
      >
      <span class="cart-line-item__sku sr-only">{{ line.sku }}</span>
    </div>
    <div class="justify-self-end">
      <AppIconButton
        :label="removeLabel"
        icon="delete"
        size="sm"
        class="text-muted"
        :disabled="disabled"
        @click="emit('remove')"
      />
    </div>
    <span class="numeric text-xs text-muted">{{ line.eachLabel ?? line.unitPrice }}</span>
    <QuantityControl
      :quantity="line.quantity"
      :decrease-label="decreaseLabel"
      :increase-label="increaseLabel"
      :group-label="quantityLabel"
      :disabled="disabled"
      @decrease="emit('decrease')"
      @increase="emit('increase')"
    />
    <span class="cart-line-item__total numeric text-end text-base font-bold whitespace-nowrap">{{
      line.lineTotal
    }}</span>
  </div>
</template>
