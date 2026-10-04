<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { formatDateTime } from '@renderer/shared/utils/format'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
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
const { error, isLoading, readiness } = storeToRefs(offlineSale)
const { t, te } = useI18n()

/**
 * Categorical blocks arrive as stable main-process tokens. An unrecognized one falls back to a
 * generic message rather than being printed raw — internal vocabulary is not operator-facing copy.
 */
const blockLabels = computed<string>(() =>
  (readiness.value?.categoricalBlocks ?? [])
    .map((token) => {
      const key = `offlineSale.categoricalBlock.${token}`

      return te(key) ? t(key) : t('offlineSale.categoricalBlock.unknown')
    })
    .join(t('common.listSeparator'))
)

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

  if (readiness.value?.noTimeLimit) {
    return t('offlineSale.noTimeLimit')
  }

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`

  return t('offlineSale.remaining', { duration })
})

const limitingReasonLabel = computed<string | null>(() => {
  const reason = readiness.value?.limitingReason

  if (!reason || reason === 'none' || readiness.value?.noTimeLimit) {
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
  <AppPanel v-if="readiness" class="offline-sale-readiness" :aria-label="t('offlineSale.title')">
    <template #header>
      <div class="flex flex-1 flex-wrap items-center gap-2">
        <AppIcon name="cloud_off" :size="22" class="text-pri-text" />
        <h2 class="offline-sale-readiness__title flex-1 text-lg font-bold">
          {{ t('offlineSale.title') }}
        </h2>
        <AppStatusChip
          :variant="readiness.canSellWithoutQuota ? 'success' : 'neutral'"
          :icon="readiness.canSellWithoutQuota ? 'check_circle' : 'inventory_2'"
        >
          {{
            readiness.mode === 'physical_presence'
              ? t('offlineSale.modePhysicalPresence')
              : t('offlineSale.modeLegacy')
          }}
        </AppStatusChip>
      </div>
    </template>

    <p class="offline-sale-readiness__mode text-sm">
      {{ readiness.canSellWithoutQuota ? t('offlineSale.canSell') : t('offlineSale.cannotSell') }}
    </p>

    <!-- No stock preparation is required in this mode, stated rather than merely implied by the
         absence of a "prepare" button. -->
    <p
      v-if="readiness.mode === 'physical_presence'"
      class="offline-sale-readiness__note text-sm text-muted"
    >
      {{ t('offlineSale.noPreparationNeeded') }}
    </p>

    <!-- Time. A countdown is shown only when trusted time is available: inventing one from the wall
         clock would let a rolled-back clock display a window that does not exist. -->
    <AppBanner v-if="readiness.clockUntrusted" variant="warning" role="note">
      {{ t('offlineSale.clockUntrusted') }}
    </AppBanner>
    <div v-else-if="remainingLabel" class="flex flex-col gap-1">
      <p class="offline-sale-readiness__remaining text-2xl font-extrabold numeric">
        {{ remainingLabel }}
      </p>
      <p v-if="limitingReasonLabel" class="offline-sale-readiness__limit text-sm text-muted">
        {{ limitingReasonLabel }}
      </p>
    </div>

    <!-- Categorical blocks: no countdown, their own reason. -->
    <AppBanner
      v-if="readiness.categoricalBlocks.length > 0"
      variant="error"
      role="status"
      icon="block"
    >
      {{ t('offlineSale.blockedBy', { reasons: blockLabels }) }}
    </AppBanner>

    <ul class="offline-sale-readiness__sync flex flex-col gap-1.5 text-sm text-muted">
      <li class="flex items-center gap-2">
        <AppIcon
          :name="readiness.pendingUploadCount === 0 ? 'cloud_done' : 'cloud_upload'"
          :size="18"
          :class="readiness.pendingUploadCount === 0 ? 'text-ok' : 'text-info'"
        />
        <span class="numeric">{{ pendingLabel }}</span>
      </li>
      <li class="flex items-center gap-2">
        <AppIcon name="history" :size="18" />
        <span class="numeric">{{ lastSyncLabel }}</span>
      </li>
    </ul>

    <!-- Advisory only. Tone is deliberately `info`, not `warning`: this does not stop a sale, and a
         danger-coloured banner would train cashiers to treat it as a refusal. -->
    <AppBanner
      v-if="readiness.inventoryWarnings.length > 0"
      variant="info"
      role="note"
      :title="t('offlineSale.inventoryWarningTitle')"
    >
      {{ t('offlineSale.inventoryWarningBody', { count: readiness.inventoryWarnings.length }) }}
    </AppBanner>

    <AppInlineError v-if="error">{{ error }}</AppInlineError>
  </AppPanel>

  <!-- Before the first answer from main. A first-load failure is shown with a retry rather than
       rendering nothing: an absent panel reads as "nothing to know", which is never true here. -->
  <AppPanel v-else class="offline-sale-readiness" :aria-label="t('offlineSale.title')">
    <template #header>
      <div class="flex flex-1 items-center gap-2">
        <AppIcon name="cloud_off" :size="22" class="text-pri-text" />
        <h2 class="offline-sale-readiness__title flex-1 text-lg font-bold">
          {{ t('offlineSale.title') }}
        </h2>
      </div>
    </template>
    <template v-if="error && !isLoading">
      <AppInlineError data-testid="offline-sale-readiness-error">{{ error }}</AppInlineError>
      <div>
        <AppButton variant="secondary" size="sm" icon="refresh" @click="offlineSale.refresh()">
          {{ t('common.retry') }}
        </AppButton>
      </div>
    </template>
    <AppLoadingSkeleton v-else :label="t('offlineSale.loading')" :lines="2" />
  </AppPanel>
</template>
