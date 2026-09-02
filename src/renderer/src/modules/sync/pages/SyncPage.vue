<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
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
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useSyncStore } from '../store'

const sync = useSyncStore()
const connectivity = useConnectivityStore()
const locale = useLocaleStore()
const { error, failureError, failures, isLoadingFailures, isUploading, status } = storeToRefs(sync)
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

onMounted(async () => {
  await sync.initialize()
  await sync.loadFailures()
})

onBeforeUnmount(() => sync.dispose())
</script>

<template>
  <section class="sync-page">
    <PageHeader
      :eyebrow="t('sync.label')"
      :title="t('sync.queuedRecords', { count: queuedCount })"
      :description="t('sync.description')"
    />

    <div class="sync-page__status-row">
      <AppStatusChip :variant="isPaused ? 'warning' : 'information'">
        {{ isPaused ? t('sync.state.paused') : t('sync.state.idle') }}
      </AppStatusChip>
      <AppStatusChip variant="neutral">
        {{ t('sync.counts.pending') }}: <span class="numeric">{{ counts.pending }}</span>
      </AppStatusChip>
      <AppStatusChip variant="neutral">
        {{ t('sync.counts.uploading') }}: <span class="numeric">{{ counts.uploading }}</span>
      </AppStatusChip>
      <AppStatusChip :variant="counts.retryableError > 0 ? 'warning' : 'neutral'">
        {{ t('sync.counts.retryableError') }}:
        <span class="numeric">{{ counts.retryableError }}</span>
      </AppStatusChip>
      <AppStatusChip :variant="counts.conflict > 0 ? 'error' : 'neutral'">
        {{ t('sync.counts.conflict') }}: <span class="numeric">{{ counts.conflict }}</span>
      </AppStatusChip>
      <AppStatusChip :variant="counts.rejected > 0 ? 'error' : 'neutral'">
        {{ t('sync.counts.rejected') }}: <span class="numeric">{{ counts.rejected }}</span>
      </AppStatusChip>
    </div>

    <AppBanner v-if="isPaused" variant="warning" role="status">
      <strong>{{ t('sync.pausedReason.title') }}</strong>
      <p>{{ pausedReasonText }}</p>
    </AppBanner>

    <div class="sync-page__actions">
      <AppButton
        variant="secondary"
        :disabled="isUploadDisabled"
        :loading="isUploading"
        :aria-label="t('sync.uploadNow')"
        :aria-describedby="uploadDisabledExplanation ? 'sync-upload-hint' : undefined"
        @click="sync.uploadNow()"
      >
        {{ isUploading ? t('sync.uploadNowBusy') : t('sync.uploadNow') }}
      </AppButton>
      <p v-if="uploadDisabledExplanation" id="sync-upload-hint" class="sync-page__hint">
        {{ uploadDisabledExplanation }}
      </p>
    </div>

    <AppInlineError v-if="error">{{ error }}</AppInlineError>

    <section class="sync-page__failures" aria-live="polite">
      <h3>{{ t('sync.failures.title') }}</h3>

      <AppBanner v-if="failures.length > 0" variant="warning" role="status">
        <strong>{{ t('sync.failures.preservationTitle') }}</strong>
        <p>{{ t('sync.failures.preservation') }}</p>
      </AppBanner>

      <AppInlineError v-if="failureError">{{ failureError }}</AppInlineError>

      <AppEmptyState
        v-if="failures.length === 0 && !isLoadingFailures"
        :title="t('sync.failures.empty')"
      />

      <ul v-else class="sync-page__failure-list">
        <li v-for="failure in failures" :key="failure.localQueueUuid" class="sync-page__failure">
          <div class="sync-page__failure-head">
            <AppStatusChip variant="error">
              {{ t(`sync.failures.state.${failure.state}`) }}
            </AppStatusChip>
            <span class="sync-page__failure-number numeric">
              {{ failure.offlineNumber ?? t('sync.failures.unknownInvoice') }}
            </span>
            <span v-if="failureTotal(failure)" class="numeric">{{ failureTotal(failure) }}</span>
          </div>
          <p class="sync-page__failure-message">
            {{ failure.message ?? t('sync.failures.noMessage') }}
          </p>
          <dl class="sync-page__failure-meta">
            <div v-if="failure.backendCode">
              <dt>{{ t('sync.failures.code') }}</dt>
              <dd>{{ failure.backendCode }}</dd>
            </div>
            <div v-if="failure.traceId">
              <dt>{{ t('sync.failures.traceId') }}</dt>
              <dd class="numeric">{{ failure.traceId }}</dd>
            </div>
            <div v-if="failureSoldAt(failure)">
              <dt>{{ t('sync.failures.soldAt') }}</dt>
              <dd>{{ failureSoldAt(failure) }}</dd>
            </div>
            <div v-if="failure.cashierUuid">
              <dt>{{ t('sync.failures.cashier') }}</dt>
              <dd class="numeric">{{ failure.cashierUuid }}</dd>
            </div>
            <div v-if="failure.shiftUuid">
              <dt>{{ t('sync.failures.shift') }}</dt>
              <dd class="numeric">{{ failure.shiftUuid }}</dd>
            </div>
          </dl>
        </li>
      </ul>

      <AppButton
        v-if="sync.hasMoreFailures"
        variant="ghost"
        :disabled="isLoadingFailures"
        :loading="isLoadingFailures"
        @click="sync.loadMoreFailures()"
      >
        {{ isLoadingFailures ? t('sync.failures.loading') : t('sync.failures.loadMore') }}
      </AppButton>
    </section>
  </section>
</template>

<style scoped>
.sync-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sync-page__status-row,
.sync-page__failure-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.sync-page__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  align-items: flex-start;
}

.sync-page__hint {
  color: var(--color-on-surface-variant);
  font-size: 0.875rem;
  margin: 0;
}

.sync-page__failures {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.sync-page__failure-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  list-style: none;
  margin: 0;
  padding: 0;
}

.sync-page__failure {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border: 1px solid var(--color-outline-variant);
  border-radius: var(--radius-2);
  padding: var(--space-3);
}

.sync-page__failure-message {
  margin: 0;
}

.sync-page__failure-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: 0;
}

.sync-page__failure-meta dt {
  color: var(--color-on-surface-variant);
  font-size: 0.75rem;
}

.sync-page__failure-meta dd {
  margin: 0;
}
</style>
