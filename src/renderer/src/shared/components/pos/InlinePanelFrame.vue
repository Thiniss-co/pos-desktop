<script setup lang="ts">
/**
 * Same slot contract as `AppDialog` (title / default / actions), rendered in place instead of as a
 * modal. Lets a flow such as `PaymentPanel` live inside the checkout column without duplicating
 * its body markup.
 */
defineProps<{ open: boolean }>()
</script>

<template>
  <section v-if="open" class="inline-panel-frame">
    <header class="inline-panel-frame__header">
      <h3 class="inline-panel-frame__title"><slot name="title" /></h3>
      <div v-if="$slots.actions" class="inline-panel-frame__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="inline-panel-frame__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.inline-panel-frame {
  display: flex;
  flex-direction: column;
  border-block-start: 2px solid var(--color-transaction-accent);
  background: var(--color-surface-container-lowest);
}

.inline-panel-frame__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4) 0;
}

.inline-panel-frame__title {
  font-size: var(--text-headline-sm-size);
}

.inline-panel-frame__actions {
  display: flex;
  gap: var(--space-2);
}

.inline-panel-frame__body {
  padding: var(--space-3) var(--space-4) var(--space-4);
}
</style>
