<script setup lang="ts">
/** Last-scan outcome notice (V3 catalog banner). Always shown so a scan never silently fails. */
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'

withDefaults(
  defineProps<{
    outcome: 'found' | 'not-found' | 'ambiguous' | 'stale-catalog' | 'unavailable-catalog'
    code: string
    hint?: string
    dismissLabel?: string
  }>(),
  { hint: undefined, dismissLabel: undefined }
)

const emit = defineEmits<{ dismiss: [] }>()
</script>

<template>
  <AppBanner
    class="barcode-feedback"
    :variant="outcome === 'found' ? 'success' : outcome === 'stale-catalog' ? 'warning' : 'error'"
    :icon="outcome === 'found' ? 'check_circle' : 'barcode'"
    role="status"
    :dismiss-label="dismissLabel"
    @dismiss="emit('dismiss')"
  >
    <span class="font-bold"><slot /></span>
    <span class="text-muted"> · </span><span class="numeric code">{{ code }}</span>
    <span v-if="hint" class="mt-0.5 block">{{ hint }}</span>
  </AppBanner>
</template>
