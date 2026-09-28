<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppSpinner from '@renderer/shared/components/common/AppSpinner.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppProgress from '@renderer/shared/components/feedback/AppProgress.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useBootstrapStore } from '../store'
import type { BootstrapStage } from '../types'

const bootstrap = useBootstrapStore()
const { error, isRetryable, isRunning, stage, status } = storeToRefs(bootstrap)
const startup = useStartupStore()
const router = useRouter()
const { t } = useI18n()

type StepState = 'done' | 'current' | 'pending'

/** The visible steps, one per real bootstrap stage the store reports while it runs. */
const STEPS: ReadonlyArray<{ stage: BootstrapStage; label: () => string }> = [
  { stage: 'validating_access', label: () => t('bootstrap.validatingAccess') },
  { stage: 'downloading', label: () => t('bootstrap.downloading') },
  { stage: 'complete', label: () => t('bootstrap.complete') }
]

/** Coarse position derived from the real stage only — never advanced by a timer. */
const STAGE_PROGRESS: Partial<Record<BootstrapStage, number>> = {
  validating_access: 33,
  downloading: 66,
  complete: 100
}

/** Local data is saved: this run completed, or a complete snapshot is already on the device. */
const isFinished = computed(
  () =>
    stage.value === 'complete' ||
    (!isRunning.value && !error.value && Boolean(status.value?.isComplete))
)

const steps = computed(() => {
  const currentIndex = isRunning.value ? STEPS.findIndex((step) => step.stage === stage.value) : -1

  return STEPS.map((step, index) => {
    const state: StepState = isFinished.value
      ? 'done'
      : index < currentIndex
        ? 'done'
        : index === currentIndex
          ? 'current'
          : 'pending'

    return { key: step.stage, label: step.label(), state }
  })
})

const STEP_STATE_LABEL: Record<StepState, () => string> = {
  done: () => t('bootstrap.stepDone'),
  current: () => t('bootstrap.stepCurrent'),
  pending: () => t('bootstrap.stepPending')
}

/** Determinate from the real stage; indeterminate while the status is still being read. */
const progress = computed<number | null>(() =>
  isFinished.value ? 100 : isRunning.value ? (STAGE_PROGRESS[stage.value] ?? null) : null
)
const showProgress = computed(() => !error.value)

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
  <div class="initializing-page flex flex-col gap-4.5">
    <PageHeader :title="t('bootstrap.title')" :description="t('bootstrap.subtitle')" />

    <AppProgress v-if="showProgress" :value="progress" :label="t('bootstrap.title')" />

    <div class="flex flex-col gap-3" role="status">
      <ol class="flex flex-col gap-3">
        <li
          v-for="step in steps"
          :key="step.key"
          class="flex items-center gap-2.5 text-base"
          :class="step.state === 'pending' ? 'text-muted' : 'text-ink'"
          :aria-current="step.state === 'current' ? 'step' : undefined"
        >
          <span class="flex w-5.5 flex-none justify-center" aria-hidden="true">
            <AppIcon v-if="step.state === 'done'" name="check_circle" :size="20" class="text-ok" />
            <AppSpinner v-else-if="step.state === 'current'" :size="18" class="text-pri-text" />
            <span v-else class="size-4 rounded-full border-2 border-muted" />
          </span>
          <span>{{ step.label }}</span>
          <span class="sr-only">({{ STEP_STATE_LABEL[step.state]() }})</span>
        </li>
      </ol>

      <p v-if="isRunning" class="text-sm text-muted">{{ t('bootstrap.keepOpen') }}</p>
      <p v-else-if="stage === 'complete' && !error" class="text-sm font-semibold text-ok">
        {{ t('bootstrap.opening') }}
      </p>
      <p v-else-if="status?.isComplete" class="text-sm text-muted">
        {{ t('bootstrap.snapshotAvailable') }}
      </p>
      <p v-else-if="!error" class="text-sm text-muted">{{ t('bootstrap.idle') }}</p>
    </div>

    <AppBanner v-if="error" variant="error" role="alert" :title="t('bootstrap.failTitle')">
      {{ error }}
    </AppBanner>
    <AppButton
      v-if="error && isRetryable && !isRunning"
      variant="primary"
      size="lg"
      full-width
      icon="refresh"
      @click="start"
    >
      {{ t('common.retry') }}
    </AppButton>
  </div>
</template>
