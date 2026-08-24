<script setup lang="ts">
withDefaults(defineProps<{ id?: string }>(), { id: undefined })
</script>

<template>
  <p :id="id" class="app-inline-error" role="alert">
    <svg class="app-inline-error__icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M8 4.5v4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <circle cx="8" cy="11.25" r="0.9" fill="currentColor" />
    </svg>
    <span><slot /></span>
  </p>
</template>

<style scoped>
.app-inline-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: var(--text-body-sm-size);
  line-height: var(--text-body-sm-line);
  color: var(--color-error);
  font-weight: 600;
}

.app-inline-error__icon {
  flex: none;
  width: 16px;
  height: 16px;
  margin-block-start: 2px;
}
</style>
