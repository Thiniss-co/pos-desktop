<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string
    description?: string
  }>(),
  { description: undefined }
)
</script>

<template>
  <div class="app-empty-state">
    <div v-if="$slots.icon" class="app-empty-state__icon" aria-hidden="true">
      <slot name="icon" />
    </div>
    <p class="app-empty-state__title">{{ title }}</p>
    <p v-if="description" class="app-empty-state__description">{{ description }}</p>
    <div v-if="$slots.action" class="app-empty-state__action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.app-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-4);
  color: var(--color-text-muted);
}

.app-empty-state__icon {
  width: 40px;
  height: 40px;
  color: var(--color-outline);
}

.app-empty-state__title {
  font-size: var(--text-body-lg-size);
  font-weight: 600;
  color: var(--color-on-surface);
}

.app-empty-state__description {
  font-size: var(--text-body-md-size);
  max-width: 40ch;
}

.app-empty-state__action {
  margin-block-start: var(--space-2);
}
</style>
