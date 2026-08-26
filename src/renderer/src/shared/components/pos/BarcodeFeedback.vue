<script setup lang="ts">
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'

withDefaults(
  defineProps<{
    outcome: 'found' | 'not-found' | 'ambiguous' | 'stale-catalog' | 'unavailable-catalog'
    code: string
  }>(),
  {}
)
</script>

<template>
  <AppBanner
    :variant="outcome === 'found' ? 'success' : outcome === 'stale-catalog' ? 'warning' : 'error'"
    role="status"
  >
    <span class="numeric">{{ code }}</span> — <slot />
  </AppBanner>
</template>
