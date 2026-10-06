<script setup lang="ts">
/**
 * POS workspace cart line — one ledger row on the cart grid shared with the column header (see
 * workspace.css): name, quantity stepper, unit price, line total and a line-actions menu. The name
 * wraps instead of truncating, and an offer adds its label under the name, so a row is as tall as
 * its content needs. Amounts arrive pre-computed and pre-formatted; this component never computes.
 *
 * Less-used actions live in the line menu (a top-layer popover, never clipped by the scrolling
 * list): the line's code and tax treatment, and Remove line. In touch mode the quantity value is a
 * direct keypad button (`editQuantityLabel`).
 */
import { ref, watch } from 'vue'
import AppDropdown from '@renderer/shared/components/common/AppDropdown.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppMenuItem from '@renderer/shared/components/common/AppMenuItem.vue'
import QuantityControl from './QuantityControl.vue'
import type { DisplayCartLine } from './types'

const props = withDefaults(
  defineProps<{
    line: DisplayCartLine
    decreaseLabel: string
    increaseLabel: string
    /** Accessible name of the Remove action ("Remove Cola Can"). */
    removeLabel: string
    /** Visible text of the Remove action in the line menu. */
    removeText?: string
    /** Accessible name of the line-menu trigger ("Actions for Cola Can"). */
    actionsLabel?: string
    quantityLabel?: string
    disabled?: boolean
    /** POS improvements, Stage 5: touch mode — the quantity opens a keypad. */
    editQuantityLabel?: string | null
    /** Bumped by the page (a scan, layout editing) to close an open line menu. */
    closeSignal?: number
  }>(),
  {
    removeText: undefined,
    actionsLabel: undefined,
    quantityLabel: undefined,
    disabled: false,
    editQuantityLabel: null,
    closeSignal: 0
  }
)

const emit = defineEmits<{ decrease: []; increase: []; remove: []; editQuantity: [] }>()

const menuOpen = ref(false)
watch(
  () => props.closeSignal,
  () => (menuOpen.value = false)
)

function remove(close: () => void): void {
  close()
  emit('remove')
}
</script>

<template>
  <div
    class="cart-line-item pos-cart-grid min-h-(--cart-row-min) border-b border-line py-(--cart-row-py)"
    role="listitem"
  >
    <div class="cart-line-item__info min-w-0">
      <span
        class="cart-line-item__name block text-(length:--cart-name-size) leading-[1.35] font-medium [overflow-wrap:anywhere]"
        >{{ line.name }}</span
      >
      <span class="cart-line-item__sku sr-only">{{ line.sku }}</span>
      <span
        v-if="line.offerLabel"
        class="cart-line-item__offer flex items-center gap-1 text-xs font-medium text-ok"
        data-testid="cart-line-offer"
        ><AppIcon name="sell" :size="14" aria-hidden="true" />{{ line.offerLabel }}</span
      >
    </div>
    <QuantityControl
      fluid
      :quantity="line.quantity"
      :decrease-label="decreaseLabel"
      :increase-label="increaseLabel"
      :group-label="quantityLabel"
      :disabled="disabled"
      :edit-label="editQuantityLabel"
      @decrease="emit('decrease')"
      @increase="emit('increase')"
      @edit="emit('editQuantity')"
    />
    <!-- The column header names it "Price"; under the name (narrow cart) it keeps its "each" label. -->
    <span class="cart-line-item__price numeric text-sm text-muted">
      <span class="cart-line-item__price-wide">{{ line.unitPrice }}</span>
      <span class="cart-line-item__price-narrow">{{ line.eachLabel ?? line.unitPrice }}</span>
    </span>
    <span class="cart-line-item__total numeric text-end font-bold whitespace-nowrap">{{
      line.lineTotal
    }}</span>
    <div class="cart-line-item__actions flex justify-end">
      <AppDropdown
        v-model:open="menuOpen"
        layer="top"
        width="260px"
        :label="actionsLabel ?? removeLabel"
        :trigger-title="actionsLabel"
        trigger-class="cart-line-item__menu flex size-(--cart-ctl) items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
      >
        <template #trigger><AppIcon name="more_horiz" :size="20" /></template>
        <template #default="{ close }">
          <p class="px-2.5 pt-1 pb-2 text-sm leading-snug">
            <span class="block font-semibold [overflow-wrap:anywhere]">{{ line.name }}</span>
            <span class="block text-xs text-muted">
              <span class="code" dir="ltr">{{ line.sku }}</span>
              <template v-if="line.detail"> · {{ line.detail }}</template>
            </span>
          </p>
          <AppMenuItem
            icon="delete"
            tone="danger"
            class="cart-line-item__remove"
            :disabled="disabled"
            :aria-label="removeLabel"
            @select="remove(close)"
            >{{ removeText ?? removeLabel }}</AppMenuItem
          >
        </template>
      </AppDropdown>
    </div>
  </div>
</template>
