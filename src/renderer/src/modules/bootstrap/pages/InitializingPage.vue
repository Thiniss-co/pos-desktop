<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useBootstrapStore } from '../store'

const bootstrap = useBootstrapStore()
const { error, isRetryable, isRunning, stage, status } = storeToRefs(bootstrap)
const startup = useStartupStore()
const router = useRouter()
const { t } = useI18n()

const stageLabels: Record<string, () => string> = {
  idle: () => t('bootstrap.idle'),
  validating_access: () => t('bootstrap.validatingAccess'),
  downloading: () => t('bootstrap.downloading'),
  complete: () => t('bootstrap.complete')
}

async function start(): Promise<void> {
  const succeeded = await bootstrap.runBootstrap()

  if (succeeded) {
    await startup.refresh()

    if (startup.state === 'ready') {
      await router.push({ name: 'pos' })
    }
  }
}

onMounted(async () => {
  await bootstrap.load()

  if (startup.state === 'needs_bootstrap' && !status.value?.isComplete) {
    void start()
  }
})

watch(
  () => startup.state,
  (state) => {
    if (state === 'access_blocked') {
      void router.push({ name: 'access-blocked' })
    }
  }
)
</script>

<template>
  <div class="startup-panel">
    <p class="startup-panel__label">{{ t('bootstrap.label') }}</p>
    <h2>{{ t('bootstrap.title') }}</h2>
    <p v-if="status?.isComplete">{{ t('bootstrap.snapshotAvailable') }}</p>
    <p v-else>{{ stageLabels[stage]?.() }}</p>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <button v-if="error && isRetryable && !isRunning" type="button" @click="start">
      {{ t('common.retry') }}
    </button>
  </div>
</template>
