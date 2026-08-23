<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
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
  <section class="shell-page">
    <p class="shell-page__label">{{ t('sync.label') }}</p>
    <h2>{{ t('sync.queuedRecords', { count: queuedCount }) }}</h2>
    <p>{{ t('sync.description') }}</p>
    <p v-if="status?.state === 'paused'" class="inline-error">{{ status.pausedReason }}</p>
    <p v-if="error" class="inline-error">{{ error }}</p>
  </section>
</template>
