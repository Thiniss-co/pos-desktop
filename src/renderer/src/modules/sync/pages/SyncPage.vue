<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { SyncFailure } from '@shared/contracts/sync.contract'
import { formatMinorCurrency } from '@shared/money/minorUnits'
import { formatDateTime } from '@renderer/shared/utils/format'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import PageContainer from '@renderer/shared/components/layout/PageContainer.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useSyncStore } from '../store'
import SyncAttentionPanel from '../components/SyncAttentionPanel.vue'
import QuickCreateRecordsPanel from '@renderer/modules/quickCreate/components/QuickCreateRecordsPanel.vue'

const sync = useSyncStore()
const connectivity = useConnectivityStore()
const locale = useLocaleStore()
const router = useRouter()
const {
  error,
  failureError,
  failures,
  isLoadingFailures,
  isLoadingSupportIssues,
  isUploading,
  status,
  supportError,
  supportIssues
} = storeToRefs(sync)
const { t, te } = useI18n()

const queuedCount = computed(() => sync.queuedCount)
const counts = computed(
  () =>
    status.value?.counts ?? {
      pending: 0,
      uploading: 0,
      retryableError: 0,
      conflict: 0,
      rejected: 0
    }
)
const isPaused = computed(() => status.value?.state === 'paused')
const isOffline = computed(() => connectivity.snapshot?.status === 'offline')

/**
 * A pause reason is a stable main-process token. An unrecognized one falls back to the generic
 * message rather than being printed raw — internal vocabulary is not operator-facing copy.
 */
const pausedReasonText = computed(() => {
  const reason = status.value?.pausedReason

  if (!reason) {
    return ''
  }

  const key = `sync.pausedReason.${reason}`

  return te(key) ? t(key) : t('sync.pausedReason.unknown')
})

// Disabling here is a convenience only. Main re-runs the full authorization gate on every
// `sync:upload-now`, so a renderer that bypasses this button gains nothing.
const isUploadDisabled = computed(() => isUploading.value || isPaused.value || isOffline.value)
const uploadDisabledExplanation = computed(() => {
  if (isUploading.value) {
    return t('sync.uploadNowDisabledBusy')
  }

  if (isPaused.value || isOffline.value) {
    return t('sync.uploadNowDisabledPaused')
  }

  return ''
})

// Presentation only: the note under Upload now. A disabled button explains itself; an enabled one
// says uploads do not depend on it (main's worker drains the queue in the background).
const uploadNote = computed(() => uploadDisabledExplanation.value || t('sync.uploadAuto'))

type Tone = 'info' | 'warn' | 'err' | 'ok' | 'neutral'

const TONE_TEXT: Record<Tone, string> = {
  info: 'text-info',
  warn: 'text-warn',
  err: 'text-err',
  ok: 'text-ok',
  neutral: 'text-muted'
}

/** The status card: always icon + colour + text, read from the live status and connectivity. */
const statusCard = computed<{ icon: IconName; tone: Tone; label: string }>(() => {
  if (isPaused.value) {
    return { icon: 'pause_circle', tone: 'warn', label: t('sync.state.paused') }
  }

  if (isOffline.value) {
    return { icon: 'wifi_off', tone: 'neutral', label: t('sync.state.offline') }
  }

  return { icon: 'sync', tone: 'ok', label: t('sync.state.idle') }
})

/** One card per real queue count; a non-zero count takes its state's colour, zero stays ink. */
const metrics = computed(() =>
  (
    [
      ['pending', counts.value.pending, 'info'],
      ['uploading', counts.value.uploading, 'info'],
      ['retryableError', counts.value.retryableError, 'warn'],
      ['conflict', counts.value.conflict, 'err'],
      ['rejected', counts.value.rejected, 'err']
    ] as const
  ).map(([key, count, tone]) => ({
    key,
    label: t(`sync.counts.${key}`),
    count,
    colour: count > 0 ? TONE_TEXT[tone] : 'text-ink'
  }))
)

function failureTotal(failure: SyncFailure): string {
  if (
    failure.totalAmount === null ||
    failure.currency === null ||
    failure.currencyExponent === null
  ) {
    return ''
  }

  const formatted = formatMinorCurrency(
    failure.totalAmount,
    locale.locale,
    failure.currency,
    failure.currencyExponent
  )

  return formatted.ok ? formatted.value : ''
}

function failureSoldAt(failure: SyncFailure): string {
  return failure.soldAt ? formatDateTime(failure.soldAt, locale.locale) : ''
}

/**
 * A plain-language explanation for the failures a cashier can otherwise do nothing with.
 *
 * The raw `backendCode` is already shown, but a code is not a reason. PS9 in particular produces a
 * terminal rejection that is nobody on this device's fault and that no retry can clear, so leaving
 * the operator to infer that from `DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE` would be
 * leaving them stuck.
 *
 * Only codes with a written explanation get one — `te()` keeps an unexplained code silent rather
 * than inventing wording for it.
 */
function failureReason(failure: SyncFailure): string | null {
  if (!failure.backendCode) {
    return null
  }

  const key = `sync.failures.reason.${failure.backendCode}`

  return te(key) ? t(key) : null
}

/**
 * The "needs attention" list is re-read whenever main pushes a new queue status (an upload, a
 * reconciliation or a recovery can change it). Returning from the POS screen remounts this page,
 * which reads it again on mount.
 */
watch(status, () => {
  void sync.loadSupportIssues()
})

function openPos(): void {
  // Resolution of a waiting payment stays on the POS screen (its recovery banner).
  void router?.push({ name: 'pos' })
}

onMounted(async () => {
  await sync.initialize()
  await Promise.all([sync.loadFailures(), sync.loadSupportIssues()])
})

onBeforeUnmount(() => sync.dispose())
</script>

<template>
  <PageContainer class="sync-page">
    <PageHeader :title="t('sync.label')" :description="t('sync.description')">
      <template #badge>
        <span class="text-sm font-semibold text-muted numeric">
          {{ t('sync.queuedRecords', { count: queuedCount }) }}
        </span>
      </template>
      <template #actions>
        <div class="flex flex-col items-end gap-1.5">
          <AppButton
            :variant="queuedCount > 0 ? 'primary' : 'secondary'"
            icon="cloud_upload"
            :disabled="isUploadDisabled"
            :loading="isUploading"
            :aria-label="t('sync.uploadNow')"
            :aria-describedby="uploadDisabledExplanation ? 'sync-upload-hint' : undefined"
            @click="sync.uploadNow()"
          >
            {{ isUploading ? t('sync.uploadNowBusy') : t('sync.uploadNow') }}
          </AppButton>
          <p
            :id="uploadDisabledExplanation ? 'sync-upload-hint' : undefined"
            class="sync-page__hint text-xs text-muted"
          >
            {{ uploadNote }}
          </p>
        </div>
      </template>
    </PageHeader>

    <AppInlineError v-if="error">{{ error }}</AppInlineError>

    <dl class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
      <div class="flex flex-col gap-1.5 rounded-lg border border-line bg-surf px-4 py-3.5">
        <dt class="text-xs font-semibold text-muted">{{ t('sync.statusLabel') }}</dt>
        <dd class="flex items-center gap-1.5 font-bold">
          <AppIcon :name="statusCard.icon" :class="TONE_TEXT[statusCard.tone]" />
          <span>{{ statusCard.label }}</span>
        </dd>
      </div>
      <div
        v-for="metric in metrics"
        :key="metric.key"
        class="flex flex-col gap-1 rounded-lg border border-line bg-surf px-4 py-3.5"
      >
        <dt class="text-xs font-semibold text-muted">{{ metric.label }}</dt>
        <dd class="text-3xl font-extrabold numeric" :class="metric.colour">{{ metric.count }}</dd>
      </div>
    </dl>

    <AppBanner
      v-if="isPaused"
      variant="warning"
      role="status"
      icon="pause_circle"
      :title="t('sync.pausedReason.title')"
    >
      <p v-if="pausedReasonText" class="font-semibold">{{ pausedReasonText }}</p>
      <p>{{ t('sync.pausedSafe') }}</p>
    </AppBanner>

    <SyncAttentionPanel
      :issues="supportIssues"
      :loading="isLoadingSupportIssues"
      :error="supportError"
      @open-pos="openPos"
    />

    <!-- POS improvements: customers, suppliers and products created on this register. -->
    <QuickCreateRecordsPanel />

    <!--
      The queue exposes counts only, never per-record rows, so this section states the real count
      rather than listing records it cannot see.
    -->
    <AppPanel :padded="false" :title="t('sync.waiting.title')">
      <p v-if="status && queuedCount > 0" class="flex items-center gap-2.5 px-4 py-4 text-sm">
        <AppIcon name="cloud_upload" :size="22" class="text-info" />
        <span class="numeric">{{ t('sync.waiting.summary', { count: queuedCount }) }}</span>
      </p>
      <p v-else-if="status" class="flex items-center gap-2.5 px-4 py-6 text-muted">
        <AppIcon name="cloud_done" :size="22" class="text-ok" />
        {{ t('sync.waiting.none') }}
      </p>
    </AppPanel>

    <AppPanel
      class="sync-page__failures"
      :padded="false"
      :title="t('sync.failures.title')"
      :description="failures.length > 0 ? t('sync.failures.reviewSafe') : undefined"
      aria-live="polite"
    >
      <div v-if="failures.length > 0" class="px-4 pt-3.5 pb-1">
        <AppBanner
          variant="warning"
          role="note"
          icon="shield"
          :title="t('sync.failures.preservationTitle')"
        >
          {{ t('sync.failures.preservation') }}
        </AppBanner>
      </div>

      <div v-if="failureError" class="px-4 pt-3">
        <AppInlineError>{{ failureError }}</AppInlineError>
      </div>

      <AppEmptyState
        v-if="failures.length === 0 && !isLoadingFailures"
        compact
        :title="t('sync.failures.empty')"
      />

      <div v-else-if="failures.length === 0" class="px-4 py-3">
        <AppLoadingSkeleton :label="t('sync.failures.loading')" :lines="2" />
      </div>

      <ul v-else class="sync-page__failure-list">
        <li
          v-for="failure in failures"
          :key="failure.localQueueUuid"
          class="sync-page__failure flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0"
        >
          <div class="sync-page__failure-head flex flex-wrap items-center gap-3 text-sm">
            <span v-if="failure.offlineNumber" class="sync-page__failure-number code font-semibold">
              {{ failure.offlineNumber }}
            </span>
            <span v-else class="sync-page__failure-number text-muted">
              {{ t('sync.failures.unknownInvoice') }}
            </span>
            <span v-if="failureSoldAt(failure)" class="text-muted numeric">
              {{ failureSoldAt(failure) }}
            </span>
            <span class="flex-1" />
            <span v-if="failureTotal(failure)" class="font-bold numeric">
              {{ failureTotal(failure) }}
            </span>
            <AppStatusChip
              variant="error"
              :icon="failure.state === 'conflict' ? 'sync_problem' : 'error'"
            >
              {{ t(`sync.failures.state.${failure.state}`) }}
            </AppStatusChip>
          </div>
          <p class="sync-page__failure-message text-sm text-pretty">
            {{ failure.message ?? t('sync.failures.noMessage') }}
          </p>
          <p v-if="failureReason(failure)" class="sync-page__failure-reason text-sm text-muted">
            {{ failureReason(failure) }}
          </p>
          <details class="group">
            <summary
              class="inline-flex min-h-9 cursor-pointer list-none items-center gap-1 rounded-md px-1 text-sm font-semibold text-pri-text [&::-webkit-details-marker]:hidden"
            >
              {{ t('sync.failures.detailsForSupport') }}
              <AppIcon name="expand_more" class="transition-transform group-open:rotate-180" />
            </summary>
            <!-- Support values stay selectable text; this page offers no copy action. -->
            <dl
              class="sync-page__failure-meta mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-notice bg-subtle p-3 text-xs select-text"
            >
              <template v-if="failure.backendCode">
                <dt class="text-muted">{{ t('sync.failures.code') }}</dt>
                <dd class="code justify-self-start break-all">{{ failure.backendCode }}</dd>
              </template>
              <template v-if="failure.traceId">
                <dt class="text-muted">{{ t('sync.failures.traceId') }}</dt>
                <dd class="code justify-self-start break-all">{{ failure.traceId }}</dd>
              </template>
              <template v-if="failureSoldAt(failure)">
                <dt class="text-muted">{{ t('sync.failures.soldAt') }}</dt>
                <dd class="numeric">{{ failureSoldAt(failure) }}</dd>
              </template>
              <template v-if="failure.cashierUuid">
                <dt class="text-muted">{{ t('sync.failures.cashier') }}</dt>
                <dd class="code justify-self-start break-all">{{ failure.cashierUuid }}</dd>
              </template>
              <template v-if="failure.shiftUuid">
                <dt class="text-muted">{{ t('sync.failures.shift') }}</dt>
                <dd class="code justify-self-start break-all">{{ failure.shiftUuid }}</dd>
              </template>
            </dl>
          </details>
        </li>
      </ul>

      <div v-if="sync.hasMoreFailures" class="border-t border-line px-4 py-3">
        <AppButton
          variant="secondary"
          size="sm"
          :disabled="isLoadingFailures"
          :loading="isLoadingFailures"
          @click="sync.loadMoreFailures()"
        >
          {{ isLoadingFailures ? t('sync.failures.loading') : t('sync.failures.loadMore') }}
        </AppButton>
      </div>
    </AppPanel>
  </PageContainer>
</template>
