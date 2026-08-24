<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'

const { t } = useI18n()
</script>

<template>
  <div class="not-found-page">
    <PageHeader :eyebrow="t('startup.notFoundLabel')" :title="t('startup.notFoundTitle')" />
    <RouterLink class="not-found-page__link" to="/">{{ t('startup.returnToStartup') }}</RouterLink>
  </div>
</template>

<style scoped>
.not-found-page {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-4);
}

.not-found-page__link {
  display: inline-flex;
  align-items: center;
  min-height: var(--size-target-min);
  padding-inline: var(--space-5);
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: var(--color-on-primary);
  text-decoration: none;
  font-weight: 600;
}

.not-found-page__link:hover {
  opacity: 0.92;
}
</style>
