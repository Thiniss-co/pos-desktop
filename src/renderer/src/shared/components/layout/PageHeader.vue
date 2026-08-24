<script setup lang="ts">
withDefaults(
  defineProps<{
    eyebrow: string
    title: string
    description?: string
  }>(),
  { description: undefined }
)
</script>

<template>
  <header class="page-header">
    <div class="page-header__heading">
      <p class="page-header__eyebrow">{{ eyebrow }}</p>
      <h2 class="page-header__title">{{ title }}</h2>
      <p v-if="description" class="page-header__description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin-block-end: var(--space-4);
}

.page-header__heading {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.page-header__eyebrow {
  font-size: var(--text-label-caps-size);
  line-height: var(--text-label-caps-line);
  letter-spacing: var(--text-label-caps-tracking);
  text-transform: uppercase;
  font-weight: var(--text-label-caps-weight);
  color: var(--color-text-muted);
}

html[dir='rtl'] .page-header__eyebrow {
  text-transform: none;
}

.page-header__title {
  font-size: var(--text-display-md-size);
  line-height: var(--text-display-md-line);
  font-weight: var(--text-display-md-weight);
  color: var(--color-on-surface);
}

.page-header__description {
  font-size: var(--text-body-lg-size);
  line-height: var(--text-body-lg-line);
  color: var(--color-on-surface-variant);
  max-width: 60ch;
}

.page-header__actions {
  display: flex;
  gap: var(--space-2);
  flex: none;
}
</style>
