<script setup lang="ts">
/**
 * V1 Windows readiness: automatic updates in Settings. Main checks and downloads in the background;
 * this panel shows where that is and offers the only way to install: a restart the cashier asks for,
 * refused (with the reason) while a sale, payment, refund, print or upload would be interrupted.
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
import { formatDateTime } from '@renderer/shared/utils/format'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { useUpdatesStore } from '../store'

const { t } = useI18n()
const store = useUpdatesStore()
const { status, busy, refusedBy } = storeToRefs(store)
const localeStore = useLocaleStore()

onMounted(() => void store.connect())
onBeforeUnmount(() => store.disconnect())

const phaseText = computed(() => {
  const current = status.value
  if (!current) return t('updates.unavailable')
  if (current.phase === 'not_configured' && current.errorCode === 'UNSIGNED_BUILD') {
    return t('updates.unsignedBuild')
  }
  return t(`updates.phase.${current.phase}`, {
    version: current.availableVersion ?? '',
    percent: String(current.percent ?? 0)
  })
})

const phaseIcon = computed(() => {
  switch (status.value?.phase) {
    case 'ready':
      return { name: 'downloading' as const, tone: 'text-pri' }
    case 'idle':
      return { name: 'check_circle' as const, tone: 'text-ok' }
    case 'checking':
    case 'downloading':
      return { name: 'sync' as const, tone: 'text-muted' }
    case 'error':
      return { name: 'warning' as const, tone: 'text-warn' }
    default:
      return { name: 'info' as const, tone: 'text-muted' }
  }
})

const blockers = computed(() => refusedBy.value ?? status.value?.blockers ?? [])

function when(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : formatDateTime(date, localeStore.locale as LocaleCode, {
        dateStyle: 'medium',
        timeStyle: 'short',
        numberingSystem: 'latn'
      })
}
</script>

<template>
  <AppPanel class="flex-[1_1_320px]" aria-labelledby="settings-updates-title">
    <h2 id="settings-updates-title" class="text-lg font-bold">{{ t('updates.title') }}</h2>
    <p class="mt-1 mb-3 text-sm text-muted">{{ t('updates.description') }}</p>

    <p
      class="flex items-start gap-2 text-sm font-semibold"
      data-testid="update-phase"
      :data-phase="status?.phase ?? 'unknown'"
    >
      <AppIcon :name="phaseIcon.name" :size="18" :class="phaseIcon.tone" class="mt-px" />
      <span>{{ phaseText }}</span>
    </p>

    <div
      v-if="status?.phase === 'downloading'"
      class="mt-2 h-2 overflow-hidden rounded-full bg-subtle"
      role="progressbar"
      :aria-valuenow="status.percent ?? 0"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="t('updates.progressLabel')"
    >
      <div class="h-full bg-pri" :style="{ width: `${status.percent ?? 0}%` }" />
    </div>

    <dl v-if="status" class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      <dt class="text-muted">{{ t('updates.currentVersion') }}</dt>
      <dd class="numeric font-semibold" dir="ltr">{{ status.currentVersion }}</dd>
      <template v-if="status.phase !== 'not_configured'">
        <dt class="text-muted">{{ t('updates.verifiedBy') }}</dt>
        <dd data-testid="update-verification" :data-verification="status.verification ?? 'none'">
          {{ status.verification ? t(`updates.verification.${status.verification}`) : '—' }}
        </dd>
        <dt class="text-muted">{{ t('updates.lastChecked') }}</dt>
        <dd class="numeric">{{ when(status.lastCheckedAt) }}</dd>
        <dt class="text-muted">{{ t('updates.nextCheck') }}</dt>
        <dd class="numeric">{{ when(status.nextCheckAt) }}</dd>
      </template>
    </dl>

    <div
      v-if="status?.phase === 'ready' && blockers.length > 0"
      class="mt-3 rounded-notice border border-line bg-subtle p-3 text-sm"
      data-testid="update-blockers"
      role="status"
    >
      <p class="font-semibold">{{ t('updates.blockedTitle') }}</p>
      <ul class="mt-1 list-disc ps-5">
        <li v-for="blocker in blockers" :key="blocker">{{ t(`updates.blocker.${blocker}`) }}</li>
      </ul>
    </div>
    <p v-if="status?.phase === 'ready'" class="mt-2 text-xs text-muted">
      {{ t('updates.pendingNote') }}
    </p>

    <div v-if="status && status.phase !== 'not_configured'" class="mt-4 flex flex-wrap gap-2">
      <AppButton
        variant="secondary"
        data-testid="update-check-now"
        :disabled="busy || ['checking', 'downloading', 'ready'].includes(status.phase)"
        @click="store.checkNow()"
      >
        {{ t('updates.checkNow') }}
      </AppButton>
      <AppButton
        v-if="status.phase === 'ready'"
        variant="primary"
        data-testid="update-restart"
        :disabled="busy || blockers.length > 0"
        @click="store.restart()"
      >
        {{ t('updates.restart') }}
      </AppButton>
    </div>
  </AppPanel>
</template>
