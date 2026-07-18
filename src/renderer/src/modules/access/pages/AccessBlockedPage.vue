<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useAccessStore } from '../store'

const { state } = storeToRefs(useAccessStore())
const startup = useStartupStore()
const router = useRouter()

async function retry(): Promise<void> {
  await startup.refresh()
  await router.push({ name: startup.state === 'ready' ? 'pos' : 'root' })
}
</script>

<template>
  <div class="startup-panel" role="alert">
    <p class="startup-panel__label">Access blocked</p>
    <h2>This workstation cannot continue yet.</h2>
    <p>{{ state.message }}</p>
    <p v-if="state.traceId" class="inline-meta">Reference: {{ state.traceId }}</p>
    <button type="button" @click="retry">Retry</button>
  </div>
</template>
