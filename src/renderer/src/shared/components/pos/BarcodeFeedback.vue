<script setup lang="ts">
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'

withDefaults(
  defineProps<{
    outcome: 'found' | 'not-found'
    code: string
  }>(),
  {}
)
</script>

<template>
  <AppBanner :variant="outcome === 'found' ? 'success' : 'error'" role="status">
    <span class="numeric">{{ code }}</span> — <slot />
  </AppBanner>
</template>
