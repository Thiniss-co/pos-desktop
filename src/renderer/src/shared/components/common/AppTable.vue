<script setup lang="ts"></script>

<template>
  <div class="app-table-wrap">
    <table class="app-table">
      <slot />
    </table>
  </div>
</template>

<style scoped>
.app-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--color-outline-variant);
  border-radius: var(--radius-lg);
}

.app-table {
  width: 100%;
  min-width: 32rem;
  border-collapse: collapse;
}

.app-table :deep(th),
.app-table :deep(td) {
  text-align: start;
  padding: var(--space-3) var(--space-4);
  border-block-end: 1px solid var(--color-divider-subtle);
  font-size: var(--text-body-md-size);
  line-height: var(--text-body-md-line);
}

.app-table :deep(thead th) {
  font-size: var(--text-label-caps-size);
  letter-spacing: var(--text-label-caps-tracking);
  text-transform: uppercase;
  font-weight: var(--text-label-caps-weight);
  color: var(--color-text-muted);
  background: var(--color-surface-container-low);
}

html[dir='rtl'] .app-table :deep(thead th) {
  text-transform: none;
}

.app-table :deep(tbody tr:last-child td) {
  border-block-end: none;
}

.app-table :deep(tbody tr:hover) {
  background: var(--color-surface-container-low);
}
</style>
