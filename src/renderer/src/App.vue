<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppLayout from './app/layouts/AppLayout.vue'
import PublicLayout from './app/layouts/PublicLayout.vue'

const route = useRoute()
const layout = computed(() => (route.meta.layout === 'app' ? AppLayout : PublicLayout))
</script>

<template>
  <component :is="layout">
    <RouterView />
  </component>
</template>
