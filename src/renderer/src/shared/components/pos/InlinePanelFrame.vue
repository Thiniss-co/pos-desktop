<script setup lang="ts">
/**
 * `AppDialog`'s slot contract (title / header-extra / default / actions) rendered in place instead
 * of as a modal, so a flow such as `PaymentPanel` can live inside the V3 cart column without
 * duplicating its body. The dialog-only props are accepted and ignored so callers can pass the
 * same bindings to either frame.
 */
withDefaults(
  defineProps<{
    open: boolean
    size?: string
    closeLabel?: string
    persistent?: boolean
  }>(),
  { size: undefined, closeLabel: undefined, persistent: false }
)
defineEmits<{ close: [] }>()
</script>

<template>
  <section
    v-if="open"
    class="inline-panel-frame flex flex-none flex-col border-t-2 border-pri bg-surf"
    aria-labelledby="inline-panel-frame-title"
  >
    <header class="flex flex-wrap items-center gap-2.5 px-4 pt-3.5 pb-2">
      <h3 id="inline-panel-frame-title" class="text-xl font-bold"><slot name="title" /></h3>
      <slot name="header-extra" />
    </header>
    <div class="inline-panel-frame__body flex flex-col px-4 pb-3">
      <slot />
    </div>
    <footer
      v-if="$slots.actions"
      class="inline-panel-frame__actions flex flex-wrap items-center gap-2.5 border-t border-line bg-subtle px-4 py-3"
    >
      <slot name="actions" />
    </footer>
  </section>
</template>
