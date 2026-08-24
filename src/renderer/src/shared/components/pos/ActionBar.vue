<script setup lang="ts"></script>

<template>
  <div class="action-bar">
    <div class="action-bar__info">
      <slot name="info" />
    </div>
    <div class="action-bar__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  border-block-start: 1px solid var(--color-outline-variant);
  background: var(--color-surface-container-lowest);
}

.action-bar__actions {
  display: flex;
  gap: var(--space-3);
}
</style>
