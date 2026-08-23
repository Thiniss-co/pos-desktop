<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppLayout from './app/layouts/AppLayout.vue'
import PublicLayout from './app/layouts/PublicLayout.vue'
import { useConnectivityStore } from './modules/connectivity/store'

const route = useRoute()
const layout = computed(() => (route.meta.layout === 'app' ? AppLayout : PublicLayout))
const connectivity = useConnectivityStore()

onMounted(() => {
  // Connectivity monitoring is best-effort diagnostic state; a failed initial read must not
  // surface as an unhandled rejection or block the rest of the app shell from rendering.
  connectivity.initialize().catch(() => undefined)
})

onBeforeUnmount(() => connectivity.dispose())
</script>

<template>
  <component :is="layout">
    <RouterView />
  </component>
</template>
