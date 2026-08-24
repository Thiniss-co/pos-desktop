<script setup lang="ts">
import { computed } from 'vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import type { SyncQueueDisplayState } from './types'

const props = defineProps<{
  state: SyncQueueDisplayState
}>()

const variant = computed(() => {
  switch (props.state) {
    case 'pending':
    case 'uploading':
      return 'info' as const
    case 'retryable-error':
      return 'warning' as const
    default:
      return 'error' as const
  }
})
</script>

<template>
  <AppBanner :variant="variant" role="status">
    <slot />
  </AppBanner>
</template>
