<script setup lang="ts">
/**
 * The cart's scrolling line list with its empty state; only this region scrolls. The page places
 * the header, customer row and totals around it (V3 cart column).
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
  }>(),
  { emptyDescription: undefined, emptyIcon: 'shopping_cart' }
)
</script>

<template>
  <section class="cart-panel flex min-h-0 flex-1 flex-col">
    <div class="cart-panel__lines min-h-30 flex-1 overflow-auto px-4">
      <AppEmptyState
        v-if="lines.length === 0"
        :title="emptyTitle"
        :description="emptyDescription"
        :icon="emptyIcon"
      />
      <slot v-else />
    </div>
    <div v-if="$slots.footer" class="cart-panel__footer flex flex-none flex-col">
      <slot name="footer" />
    </div>
  </section>
</template>
