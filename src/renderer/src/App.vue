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
  void connectivity.initialize()
})

onBeforeUnmount(() => connectivity.dispose())
</script>

<template>
  <component :is="layout">
    <RouterView />
  </component>
</template>
