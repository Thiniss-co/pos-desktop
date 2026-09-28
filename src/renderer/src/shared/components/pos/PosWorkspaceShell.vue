<script setup lang="ts">
/**
 * V3 selling layout: the catalog panel (fluid) beside the cart column (340 / 380 / 420px at
 * < 1200 / ≥ 1200 / ≥ 1600). Below 900px the cart leaves the row and becomes a full-height sheet
 * (`sheetOpen`), with the `compact-bar` summary pinned to the bottom. RTL mirrors automatically
 * (the cart sits on the left) because the row follows the document direction.
 */
withDefaults(defineProps<{ sheetOpen?: boolean; catalogLabel?: string; cartLabel?: string }>(), {
  sheetOpen: false,
  catalogLabel: undefined,
  cartLabel: undefined
})
</script>

<template>
  <div class="pos-workspace-shell flex min-h-0 flex-1 flex-col">
    <div
      v-if="$slots.toolbar"
      class="pos-workspace-shell__toolbar flex flex-none flex-col gap-2 px-4 pt-4"
    >
      <slot name="toolbar" />
    </div>
    <div class="pos-workspace-shell__body flex min-h-0 flex-1 gap-4 p-3 wide:p-4">
      <section
        class="pos-workspace-shell__catalog flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-line bg-surf p-3 shadow-panel wide:p-4"
        :aria-label="catalogLabel"
      >
        <slot name="catalog" />
      </section>
      <aside
        class="pos-workspace-shell__cart min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-surf"
        :class="
          sheetOpen
            ? 'fixed inset-0 z-40 flex'
            : 'hidden w-[340px] flex-none rounded-lg border border-line shadow-panel wide:flex cartlg:w-[380px] hd:w-[420px]'
        "
        :aria-label="cartLabel"
      >
        <slot name="cart" />
      </aside>
    </div>
    <div v-if="$slots['compact-bar'] && !sheetOpen" class="flex-none wide:hidden">
      <slot name="compact-bar" />
    </div>
  </div>
</template>
