<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
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
  <div class="initializing-page">
    <PageHeader :eyebrow="t('bootstrap.label')" :title="t('bootstrap.title')" />
    <p v-if="status?.isComplete">{{ t('bootstrap.snapshotAvailable') }}</p>
    <AppLoadingSkeleton v-else-if="isRunning" :label="stageLabels[stage]?.()" :lines="2" />
    <p v-else>{{ stageLabels[stage]?.() }}</p>
    <AppInlineError v-if="error">{{ error }}</AppInlineError>
    <AppButton v-if="error && isRetryable && !isRunning" variant="secondary" @click="start">
      {{ t('common.retry') }}
    </AppButton>
  </div>
</template>

<style scoped>
.initializing-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
