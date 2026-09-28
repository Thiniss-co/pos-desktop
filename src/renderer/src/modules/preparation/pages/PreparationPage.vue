<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import { formatDateTime, formatNumber } from '@renderer/shared/utils/format'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { useCatalogStore } from '@renderer/modules/pos/catalog.store'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
import AppProgress from '@renderer/shared/components/feedback/AppProgress.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import AppTable from '@renderer/shared/components/common/AppTable.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import PageContainer from '@renderer/shared/components/layout/PageContainer.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import type {
  PreparationProductCoverage,
  PreparationQuantityState
} from '@shared/contracts/preparation.contract'
import OfflineSaleReadinessPanel from '@renderer/modules/offlineSale/components/OfflineSaleReadinessPanel.vue'
import { useOfflineSaleStore } from '@renderer/modules/offlineSale/store'
import { usePreparationStore } from '../store'

/**
 * CP4 — the readiness screen (plan §8.6).
 *
 * Two panels, never merged: **time coverage** and **quantity coverage**. §8.1 is explicit that they
 * are independent — a time-ready workstation can still sell only the finite allocated quantity, and
 * ample quantity does not extend an earlier time guard. A single combined "ready" indicator would
 * be a lie in both directions.
 *
 * Every number rendered here comes from main. The countdown in particular is never computed in the
 * renderer: §8.5 forbids re-deriving it from the moment the screen opened, and a renderer clock is
 * exactly how that would happen by accident.
 */

const preparation = usePreparationStore()
const locale = useLocaleStore()
const { error, isLoading, isRunning, readiness } = storeToRefs(preparation)

/**
 * PS6 §14.3: in `physical_presence` a server-issued authority — not preparation — permits offline
 * selling, so the page must not present preparation as a requirement (no "Prepare" action, no
 * "not prepared" state). Unresolved operations are still reported: an ambiguous operation is never
 * hidden, whatever the mode. Until main has answered, the legacy page is shown.
 */
const { isPhysicalPresence } = storeToRefs(useOfflineSaleStore())
const { t, te } = useI18n()

const time = computed(() => readiness.value?.time ?? null)
const products = computed(() => readiness.value?.quantity.products ?? [])
const blockedProducts = computed(() => readiness.value?.blockedProducts ?? [])

/**
 * The readiness projection names products by uuid only. Names are resolved from the workstation's
 * own local catalog (the same read the POS page uses); an unknown uuid keeps showing the uuid.
 */
const catalog = useCatalogStore()
const productNames = reactive(new Map<string, string>())
watch(
  () => [
    ...products.value.map((p) => p.productUuid),
    ...blockedProducts.value.map((b) => b.productUuid)
  ],
  async (uuids) => {
    for (const uuid of uuids) {
      if (productNames.has(uuid)) {
        continue
      }
      const product = await catalog.getProduct(uuid).catch(() => null)
      if (product) {
        productNames.set(uuid, product.name)
      }
    }
  },
  { immediate: true }
)
const unresolvedOperations = computed(() => readiness.value?.unresolvedOperations ?? [])

/**
 * The headline.
 *
 * §8.6: the exact phrase "Ready for 72 hours" appears **only** when both predicates pass *and* the
 * full requested window still remains — that is, only at the moment of a successful preparation.
 * From the next second onward the honest statement is a countdown. Main distinguishes those as two
 * separate states, so this is a lookup rather than a judgement this component could get wrong.
 */
const timeHeadline = computed(() => {
  const state = time.value?.state ?? 'not_prepared'

  if (state === 'ready_full_window') {
    return t('preparation.time.readyFullWindow', {
      hours: Math.round((time.value?.requestedDurationSeconds ?? 0) / 3600)
    })
  }

  if (state === 'counting_down' || state === 'partial_time') {
    return t('preparation.time.remaining', { duration: remainingText.value })
  }

  return t(`preparation.time.state.${state}`)
})

/** A humanized remaining duration. Formatting only — the seconds themselves come from main. */
const remainingText = computed(() => {
  const seconds = time.value?.remainingSeconds ?? 0
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  return t('preparation.time.durationHoursMinutes', { hours, minutes })
})

/**
 * A limiting reason is a stable main-process token. An unrecognized one falls back to a generic
 * message rather than being printed raw — internal vocabulary is not operator-facing copy.
 */
function reasonText(reason: string | null): string {
  if (!reason) {
    return ''
  }

  const key = `preparation.reason.${reason}`

  return te(key) ? t(key) : t('preparation.reason.unknown')
}

function blockedReasonText(reason: string): string {
  const key = `preparation.blockedReason.${reason}`

  return te(key) ? t(key) : t('preparation.blockedReason.unknown')
}

/** Expired and blocked are refusals, so the headline takes the error colour (with its own text). */
const timeHeadlineIsRefusal = computed(
  () => time.value?.state === 'expired' || time.value?.state === 'blocked'
)

/**
 * The share of the originally prepared window that still remains, as a bar. Both numbers come from
 * main — nothing here reads a clock — so it is a display ratio, not a re-derived countdown.
 */
const remainingPercent = computed<number | null>(() => {
  const requested = time.value?.requestedDurationSeconds ?? 0
  const state = time.value?.state

  if (requested <= 0 || state === 'blocked' || state === 'not_prepared') {
    return null
  }

  return Math.min(100, ((time.value?.remainingSeconds ?? 0) / requested) * 100)
})

const QUANTITY_CHIP: Record<
  PreparationQuantityState,
  { variant: 'success' | 'warning' | 'error' | 'neutral'; icon: IconName }
> = {
  full: { variant: 'success', icon: 'check_circle' },
  partial: { variant: 'warning', icon: 'warning' },
  zero: { variant: 'neutral', icon: 'remove' },
  reconciliation_required: { variant: 'warning', icon: 'sync_problem' }
}

/** The secondary quantities, shown under the product only when they are not zero. */
function secondaryQuantities(product: PreparationProductCoverage): string[] {
  return (
    [
      ['preparation.quantity.coveredForWindow', product.coveredForWindowMilli],
      ['preparation.quantity.shortLived', product.shortLivedMilli],
      ['preparation.quantity.heldNotSpendable', product.heldNotSpendableMilli]
    ] as const
  )
    .filter(([, milli]) => milli > 0)
    .map(([key, milli]) => `${t(key)} ${formatQuantity(milli)}`)
}

function formatQuantity(milli: number): string {
  return formatNumber(milli / 1000, locale.locale as LocaleCode, {
    maximumFractionDigits: 3
  })
}

onMounted(() => {
  preparation.start()
})

onBeforeUnmount(() => {
  preparation.stop()
})
</script>

<template>
  <PageContainer class="preparation-page">
    <PageHeader
      :title="t('preparation.title')"
      :description="
        isPhysicalPresence
          ? t('preparation.descriptionPhysicalPresence')
          : t('preparation.description')
      "
    >
      <template v-if="!isPhysicalPresence" #actions>
        <AppButton
          variant="secondary"
          icon="downloading"
          :disabled="isRunning || isLoading"
          :loading="isRunning"
          @click="preparation.runCycle()"
        >
          {{ isRunning ? t('preparation.actions.preparing') : t('preparation.actions.prepare') }}
        </AppButton>
      </template>
    </PageHeader>

    <!--
      PS6 §14.3: the offline-selling status (mode, window and its limit, categorical blocks,
      unsent sales, last sync). It is read-only and sits above preparation because in
      `physical_presence` it — not preparation — says whether this workstation may sell offline.
    -->
    <OfflineSaleReadinessPanel />

    <!--
      An operation that is ambiguous or awaiting replay is NEVER rendered as a successful
      preparation (§8.6). It is reported here, as unresolved, with its pending action — in either
      offline-selling mode.
    -->
    <AppBanner
      v-if="unresolvedOperations.length > 0"
      variant="info"
      role="status"
      icon="hourglass_top"
      data-testid="preparation-unresolved"
    >
      {{ t('preparation.unresolved', { count: unresolvedOperations.length }) }}
    </AppBanner>

    <template v-if="!isPhysicalPresence">
      <AppInlineError v-if="error">{{ error }}</AppInlineError>

      <AppPanel v-if="!readiness && isLoading">
        <AppLoadingSkeleton :label="t('preparation.loading')" />
      </AppPanel>

      <AppPanel v-else-if="!readiness || !readiness.available">
        <AppEmptyState
          icon="inventory_2"
          :title="t('preparation.empty.title')"
          :description="t('preparation.empty.description')"
        />
      </AppPanel>

      <div
        v-else
        class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-4"
      >
        <!--
          §8.6 panel 1 — time coverage. It reports what was originally prepared for *and* what
          actually remains, as two separate facts. A historical success is never re-displayed as
          though the full window were still ahead.
        -->
        <AppPanel data-testid="preparation-time-panel">
          <template #header>
            <div class="flex flex-1 flex-wrap items-center gap-2">
              <AppIcon name="schedule" :size="22" class="text-pri-text" />
              <h2 class="flex-1 text-lg font-bold">{{ t('preparation.time.title') }}</h2>
              <AppStatusChip v-if="time?.state === 'partial_time'" variant="warning">
                {{ t('preparation.time.state.partial_time') }}
              </AppStatusChip>
            </div>
          </template>

          <p class="text-4xl font-extrabold numeric" :class="{ 'text-err': timeHeadlineIsRefusal }">
            {{ timeHeadline }}
          </p>

          <template v-if="remainingPercent !== null">
            <AppProgress
              :value="remainingPercent"
              size="md"
              :label="t('preparation.time.remainingShare')"
            />
            <div class="flex justify-between gap-3 text-xs text-muted numeric">
              <span>{{ t('preparation.time.remainingLabel') }}</span>
              <span>
                {{
                  t('preparation.time.window', {
                    hours: Math.round((time?.requestedDurationSeconds ?? 0) / 3600)
                  })
                }}
              </span>
            </div>
          </template>

          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt class="text-muted">{{ t('preparation.time.preparedAt') }}</dt>
            <dd class="font-semibold numeric">
              {{ time?.preparedAt ? formatDateTime(time.preparedAt, locale.locale) : '—' }}
            </dd>
            <dt class="text-muted">{{ t('preparation.time.originallyPreparedFor') }}</dt>
            <dd class="font-semibold numeric">
              {{
                time?.requestedDurationSeconds
                  ? t('preparation.time.hours', {
                      hours: Math.round(time.requestedDurationSeconds / 3600)
                    })
                  : '—'
              }}
            </dd>
            <dt class="text-muted">{{ t('preparation.time.remainingLabel') }}</dt>
            <dd class="font-semibold numeric" data-testid="preparation-remaining">
              {{ remainingText }}
            </dd>
            <dt class="text-muted">{{ t('preparation.time.supportedUntil') }}</dt>
            <dd class="font-semibold numeric">
              {{
                time?.effectiveReadyUntil
                  ? formatDateTime(time.effectiveReadyUntil, locale.locale)
                  : '—'
              }}
            </dd>
            <template v-if="time?.limitingReason">
              <dt class="text-muted">{{ t('preparation.time.limitedBy') }}</dt>
              <!-- Every tied limiter is shown: §8.6 forbids hiding a simultaneous second one. -->
              <dd class="font-semibold">
                {{
                  (time.tiedLimitingReasons.length > 0
                    ? time.tiedLimitingReasons
                    : [time.limitingReason]
                  )
                    .map(reasonText)
                    .join(t('common.listSeparator'))
                }}
              </dd>
            </template>
          </dl>

          <AppBanner v-if="time?.newlyObservedRestriction" variant="warning" role="note">
            {{
              t('preparation.time.newlyObserved', {
                reason: reasonText(time.newlyObservedRestriction)
              })
            }}
          </AppBanner>
        </AppPanel>

        <!--
          §8.6 panel 2 — quantity coverage. Deliberately separate from time: the quantity panel may
          read zero while time is non-zero, and that is an honest state, not a contradiction.
        -->
        <AppPanel :padded="false" data-testid="preparation-quantity-panel">
          <div class="flex flex-wrap items-center gap-2 px-4.5 pt-4.5 pb-3">
            <AppIcon name="inventory_2" :size="22" class="text-pri-text" />
            <h2 class="flex-1 text-lg font-bold">{{ t('preparation.quantity.title') }}</h2>
            <AppStatusChip
              :variant="QUANTITY_CHIP[readiness.quantity.state].variant"
              :icon="QUANTITY_CHIP[readiness.quantity.state].icon"
            >
              {{ t(`preparation.quantity.state.${readiness.quantity.state}`) }}
            </AppStatusChip>
          </div>

          <AppTable
            v-if="products.length > 0"
            :framed="false"
            :label="t('preparation.quantity.title')"
          >
            <thead>
              <tr>
                <th scope="col">{{ t('preparation.quantity.product') }}</th>
                <th scope="col" class="text-center!">{{ t('preparation.quantity.usableNow') }}</th>
                <th scope="col">{{ t('preparation.quantity.status') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="product in products" :key="product.productUuid">
                <td>
                  <span v-if="productNames.get(product.productUuid)" class="font-medium">{{
                    productNames.get(product.productUuid)
                  }}</span>
                  <span v-else class="code break-all">{{ product.productUuid }}</span>
                  <span
                    v-if="secondaryQuantities(product).length > 0"
                    class="mt-0.5 block text-xs text-muted numeric"
                  >
                    {{ secondaryQuantities(product).join(t('common.listSeparator')) }}
                  </span>
                </td>
                <td class="text-center font-bold numeric">
                  {{ formatQuantity(product.usableNowMilli) }}
                </td>
                <td>
                  <AppStatusChip
                    size="sm"
                    :variant="QUANTITY_CHIP[product.state].variant"
                    :icon="QUANTITY_CHIP[product.state].icon"
                  >
                    {{ t(`preparation.quantity.state.${product.state}`) }}
                  </AppStatusChip>
                </td>
              </tr>
            </tbody>
          </AppTable>
          <AppEmptyState v-else compact :title="t('preparation.quantity.empty')" />

          <p class="border-t border-line px-4.5 py-3 text-xs text-muted">
            {{ t('preparation.quantity.note') }}
          </p>

          <div
            v-if="blockedProducts.length > 0"
            class="flex flex-col gap-2 border-t border-line px-4.5 pt-3.5 pb-4.5"
          >
            <h3 class="text-base font-bold">
              {{ t('preparation.blocked.titleCount', { count: blockedProducts.length }) }}
            </h3>
            <p class="text-xs text-muted">{{ t('preparation.blocked.description') }}</p>
            <ul class="flex flex-col gap-1.5">
              <li
                v-for="blocked in blockedProducts"
                :key="blocked.productUuid"
                class="flex items-start gap-2 text-sm"
              >
                <AppIcon name="block" :size="18" class="mt-0.5 shrink-0 text-err" />
                <span>
                  <strong v-if="productNames.get(blocked.productUuid)" class="font-semibold">{{
                    productNames.get(blocked.productUuid)
                  }}</strong>
                  <strong v-else class="code font-semibold break-all">{{
                    blocked.productUuid
                  }}</strong>
                  — {{ blockedReasonText(blocked.reason) }}
                </span>
              </li>
            </ul>
          </div>
        </AppPanel>
      </div>
    </template>
  </PageContainer>
</template>
