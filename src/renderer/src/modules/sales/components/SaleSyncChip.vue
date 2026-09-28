<script setup lang="ts">
/**
 * The sale's upload status as a V3 pill. The mapping is the one both sales pages always used:
 * `synced` → synced, `rejected`/`conflict` → sync failed, anything else (pending, uploading,
 * retryable_error) → not synced yet. Presentation only.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'

const props = withDefaults(defineProps<{ status: string; size?: 'sm' | 'md' }>(), {
  size: 'md'
})

const { t } = useI18n()

const tone = computed(() => {
  if (props.status === 'synced') {
    return { variant: 'success', icon: 'cloud_done', label: t('sales.syncSynced') } as const
  }
  if (props.status === 'rejected' || props.status === 'conflict') {
    return { variant: 'error', icon: 'error', label: t('sales.syncFailed') } as const
  }
  return { variant: 'information', icon: 'cloud_upload', label: t('sales.syncPending') } as const
})
</script>

<template>
  <AppStatusChip :variant="tone.variant" :icon="tone.icon" :size="size">{{
    tone.label
  }}</AppStatusChip>
</template>
