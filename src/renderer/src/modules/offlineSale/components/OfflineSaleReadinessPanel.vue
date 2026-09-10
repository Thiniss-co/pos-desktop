<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { formatDateTime } from '@renderer/shared/utils/format'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import { useOfflineSaleStore } from '../store'

/**
 * PS6 §14.3 — the operator's offline-selling status.
 *
 * ## Three things kept visually and semantically apart
 *
 * The panel never merges them, because merging is how an operator ends up misinformed:
 *
 *  1. **remaining time** — a countdown, with the boundary that produced it named. §14.3 requires the
 *     limiting reason to be shown, not just the number, so "2 hours left" is never mistaken for the
 *     72-hour ceiling when it is really the catalog contract expiring;
 *  2. **categorical blocks** — device revoked, permission removed, shift closed. Not time
 *     comparisons, so they get no countdown and are listed on their own;
 *  3. **the inventory warning** — advisory only. It says the ledger is behind; it never says the
 *     cashier may not sell.
 *
 * Every value is read from main. Nothing here is computed from the wall clock: re-deriving the
 * countdown in the renderer is exactly how a window appears to reset on navigation.
 */

const offlineSale = useOfflineSaleStore()
const locale = useLocaleStore()
const { error, readiness } = storeToRefs(offlineSale)
const { t } = useI18n()

onMounted(() => {
  void offlineSale.refresh()
})

/** Whole hours and minutes. Deliberately coarse: a per-second countdown invites clock-watching. */
const remainingLabel = computed<string | null>(() => {
  const seconds = readiness.value?.remainingSeconds

  if (seconds === null || seconds === undefined) {
    return null
  }

  if (seconds <= 0) {
    return t('offlineSale.remainingExpired')
  }

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`

  return t('offlineSale.remaining', { duration })
})

const limitingReasonLabel = computed<string | null>(() => {
  const reason = readiness.value?.limitingReason

  if (!reason || reason === 'none') {
    return null
  }

  return t('offlineSale.limitedBy', { reason: t(`offlineSale.limitingReason.${reason}`) })
})

const lastSyncLabel = computed<string>(() => {
  const at = readiness.value?.lastSuccessfulSyncAt

  return at
    ? t('offlineSale.lastSync', { at: formatDateTime(at, locale.locale) })
    : t('offlineSale.lastSyncNever')
})

const pendingLabel = computed<string>(() => {
  const count = readiness.value?.pendingUploadCount ?? 0

  return count === 0
    ? t('offlineSale.pendingUploadsNone')
    : t('offlineSale.pendingUploads', { count })
})
</script>

<template>
  <section v-if="readiness" class="offline-sale-readiness" :aria-label="t('offlineSale.title')">
    <header class="offline-sale-readiness__header">
      <h2 class="offline-sale-readiness__title">{{ t('offlineSale.title') }}</h2>
      <AppStatusChip :tone="readiness.canSellWithoutQuota ? 'success' : 'neutral'">
        {{
          readiness.mode === 'physical_presence'
            ? t('offlineSale.modePhysicalPresence')
            : t('offlineSale.modeLegacy')
        }}
      </AppStatusChip>
    </header>

    <p class="offline-sale-readiness__mode">
      {{ readiness.canSellWithoutQuota ? t('offlineSale.canSell') : t('offlineSale.cannotSell') }}
    </p>

    <!-- No stock preparation is required in this mode, stated rather than merely implied by the
         absence of a "prepare" button. -->
    <p v-if="readiness.mode === 'physical_presence'" class="offline-sale-readiness__note">
      {{ t('offlineSale.noPreparationNeeded') }}
    </p>

    <!-- Time. A countdown is shown only when trusted time is available: inventing one from the wall
         clock would let a rolled-back clock display a window that does not exist. -->
    <AppBanner v-if="readiness.clockUntrusted" tone="warning">
      {{ t('offlineSale.clockUntrusted') }}
    </AppBanner>
    <template v-else-if="remainingLabel">
      <p class="offline-sale-readiness__remaining">{{ remainingLabel }}</p>
      <p v-if="limitingReasonLabel" class="offline-sale-readiness__limit">
        {{ limitingReasonLabel }}
      </p>
    </template>

    <!-- Categorical blocks: no countdown, their own reason. -->
    <AppBanner v-if="readiness.categoricalBlocks.length > 0" tone="danger">
      {{ t('offlineSale.blockedBy', { reasons: readiness.categoricalBlocks.join(', ') }) }}
    </AppBanner>

    <dl class="offline-sale-readiness__sync">
      <div>
        <dt>{{ t('offlineSale.pendingUploads', { count: 0 }) }}</dt>
        <dd>{{ pendingLabel }}</dd>
      </div>
      <div>
        <dd>{{ lastSyncLabel }}</dd>
      </div>
    </dl>

    <!-- Advisory only. Tone is deliberately `info`, not `warning`: this does not stop a sale, and a
         danger-coloured banner would train cashiers to treat it as a refusal. -->
    <AppBanner v-if="readiness.inventoryWarnings.length > 0" tone="info">
      <strong>{{ t('offlineSale.inventoryWarningTitle') }}</strong>
      {{ t('offlineSale.inventoryWarningBody', { count: readiness.inventoryWarnings.length }) }}
    </AppBanner>

    <AppInlineError v-if="error" :message="error" />
  </section>
</template>

<style scoped>
.offline-sale-readiness {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 0.75rem);
  padding: var(--space-4, 1rem);
  border: 1px solid var(--color-border, #d8dee6);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface, #fff);
}

.offline-sale-readiness__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 0.5rem);
  flex-wrap: wrap;
}

.offline-sale-readiness__title {
  margin: 0;
  font-size: var(--font-size-md, 1rem);
  font-weight: 600;
}

.offline-sale-readiness__mode,
.offline-sale-readiness__note,
.offline-sale-readiness__remaining,
.offline-sale-readiness__limit {
  margin: 0;
}

.offline-sale-readiness__remaining {
  font-size: var(--font-size-lg, 1.125rem);
  font-weight: 600;
}

.offline-sale-readiness__limit,
.offline-sale-readiness__note {
  color: var(--color-text-muted, #5b6774);
  font-size: var(--font-size-sm, 0.875rem);
}

.offline-sale-readiness__sync {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 0.25rem);
  font-size: var(--font-size-sm, 0.875rem);
  color: var(--color-text-muted, #5b6774);
}

.offline-sale-readiness__sync dt {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.offline-sale-readiness__sync dd {
  margin: 0;
}
</style>
