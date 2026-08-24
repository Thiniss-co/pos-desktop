<script setup lang="ts">
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
</script>

<template>
  <AppBanner variant="warning" role="alert">
    <slot />
  </AppBanner>
</template>
