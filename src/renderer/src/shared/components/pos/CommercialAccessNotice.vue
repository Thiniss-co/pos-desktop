<script setup lang="ts">
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'

withDefaults(
  defineProps<{
    severity?: 'warning' | 'error'
  }>(),
  { severity: 'warning' }
)
</script>

<template>
  <AppBanner :variant="severity" role="alert">
    <slot />
    <template v-if="$slots.action" #action>
      <slot name="action" />
    </template>
  </AppBanner>
</template>
