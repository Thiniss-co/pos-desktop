<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useAccessStore } from '../store'

const { state } = storeToRefs(useAccessStore())
const startup = useStartupStore()
const router = useRouter()
const { t } = useI18n()

async function retry(): Promise<void> {
  await startup.refresh()
  await router.push({ name: startup.state === 'ready' ? 'pos' : 'root' })
}
</script>

<template>
  <div class="startup-panel" role="alert">
    <p class="startup-panel__label">{{ t('startup.accessBlockedLabel') }}</p>
    <h2>{{ t('startup.accessBlockedTitle') }}</h2>
    <p>{{ state.message }}</p>
    <p v-if="state.traceId" class="inline-meta">
      {{ t('startup.reference', { traceId: state.traceId }) }}
    </p>
    <button type="button" @click="retry">{{ t('common.retry') }}</button>
  </div>
</template>
