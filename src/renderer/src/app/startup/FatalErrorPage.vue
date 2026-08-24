<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useStartupStore } from './startup.store'

const { error } = storeToRefs(useStartupStore())
const { t, te } = useI18n()
const message = computed(() =>
  error.value?.detail
    ? localizeAppError(error.value.detail, t, te)
    : (error.value?.message ?? t('startup.fatalFallback'))
)
</script>

<template>
  <div class="fatal-error-page" role="alert">
    <PageHeader :eyebrow="t('startup.fatalLabel')" :title="t('startup.fatalTitle')" />
    <p>{{ message }}</p>
  </div>
</template>

<style scoped>
.fatal-error-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
