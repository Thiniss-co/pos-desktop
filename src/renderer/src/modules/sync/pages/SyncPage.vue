<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useSyncStore } from '../store'

const sync = useSyncStore()
const { error, status } = storeToRefs(sync)
const queuedCount = computed(() => {
  const counts = status.value?.counts

  return counts
    ? counts.pending + counts.uploading + counts.retryableError + counts.conflict + counts.rejected
    : 0
})
const { t } = useI18n()

onMounted(() => void sync.refresh())
</script>

<template>
  <section class="sync-page">
    <PageHeader
      :eyebrow="t('sync.label')"
      :title="t('sync.queuedRecords', { count: queuedCount })"
      :description="t('sync.description')"
    />
    <AppInlineError v-if="status?.state === 'paused'">{{ status.pausedReason }}</AppInlineError>
    <AppInlineError v-if="error">{{ error }}</AppInlineError>
  </section>
</template>

<style scoped>
.sync-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
