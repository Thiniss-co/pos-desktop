<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useBootstrapStore } from '../store'

const bootstrap = useBootstrapStore()
const { error, status } = storeToRefs(bootstrap)

onMounted(() => void bootstrap.load())
</script>

<template>
  <div class="startup-panel">
    <p class="startup-panel__label">03 / local bootstrap</p>
    <h2>Preparing the workstation’s local data.</h2>
    <p v-if="status?.isComplete">A bootstrap snapshot is available locally.</p>
    <p v-else>Bootstrap data will be persisted after the authenticated Phase 2 flow.</p>
    <p v-if="error" class="inline-error">{{ error }}</p>
  </div>
</template>
