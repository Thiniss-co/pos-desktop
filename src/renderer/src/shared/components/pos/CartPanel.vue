<script setup lang="ts">
/**
 * The cart's scrolling line list with its empty state; only this region scrolls. In the POS
 * workspace the page places the toolbar, scan entry, column header and the pinned totals around it
 * as separate sections, so the lines are the only part of the cart that ever scrolls.
 */
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import type { DisplayCartLine } from './types'

withDefaults(
  defineProps<{
    lines: readonly DisplayCartLine[]
    emptyTitle: string
    emptyDescription?: string
    emptyIcon?: IconName
    /** Accessible name of the line list. */
    listLabel?: string
  }>(),
  { emptyDescription: undefined, emptyIcon: 'shopping_cart', listLabel: undefined }
)
</script>

<template>
  <section class="cart-panel flex min-h-0 flex-1 flex-col">
    <!-- `relative`: the lines' visually hidden texts are positioned; containing them here keeps them
         clipped by this scroller instead of stretching the page. -->
    <div class="cart-panel__lines relative min-h-18 flex-1 overflow-auto overscroll-contain px-3">
      <AppEmptyState
        v-if="lines.length === 0"
        :title="emptyTitle"
        :description="emptyDescription"
        :icon="emptyIcon"
      />
      <div v-else role="list" :aria-label="listLabel"><slot /></div>
    </div>
    <div v-if="$slots.footer" class="cart-panel__footer flex flex-none flex-col">
      <slot name="footer" />
    </div>
  </section>
</template>
