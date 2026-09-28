<script setup lang="ts">
/** Native table in a V3 panel: tinted header row, 1px row rules, 12px/16px cell rhythm. */
withDefaults(defineProps<{ label?: string; framed?: boolean }>(), {
  label: undefined,
  framed: true
})
</script>

<template>
  <div
    class="app-table-wrap min-w-0 overflow-x-auto"
    :class="{ 'rounded-lg border border-line bg-surf shadow-panel': framed }"
  >
    <table class="app-table w-full border-collapse text-sm" :aria-label="label">
      <slot />
    </table>
  </div>
</template>

<style scoped>
.app-table :deep(th) {
  padding: 10px 16px;
  background: var(--color-subtle);
  color: var(--color-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  text-align: start;
  white-space: nowrap;
}

.app-table :deep(td) {
  padding: 12px 16px;
  border-block-start: 1px solid var(--color-line);
  vertical-align: middle;
}

.app-table :deep(tbody tr:hover td) {
  background: color-mix(in srgb, var(--color-subtle) 60%, transparent);
}
</style>
