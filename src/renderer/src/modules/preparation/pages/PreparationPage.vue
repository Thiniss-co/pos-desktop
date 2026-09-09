<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { formatDateTime } from '@renderer/shared/utils/format'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
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
const { t, te } = useI18n()

const time = computed(() => readiness.value?.time ?? null)
const products = computed(() => readiness.value?.quantity.products ?? [])
const blockedProducts = computed(() => readiness.value?.blockedProducts ?? [])
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

const timeChipTone = computed(() => {
  switch (time.value?.state) {
    case 'ready_full_window':
      return 'success'
    case 'counting_down':
      return 'success'
    case 'partial_time':
      return 'warning'
    case 'expired':
    case 'blocked':
      return 'danger'
    default:
      return 'neutral'
  }
})

function formatQuantity(milli: number): string {
  return (milli / 1000).toFixed(3)
}

onMounted(() => {
  preparation.start()
})

onBeforeUnmount(() => {
  preparation.stop()
})
</script>

<template>
  <section class="preparation-page">
    <PageHeader
      :eyebrow="t('preparation.eyebrow')"
      :title="t('preparation.title')"
      :description="t('preparation.description')"
    >
      <template #actions>
        <AppButton
          :disabled="isRunning || isLoading"
          :loading="isRunning"
          @click="preparation.runCycle()"
        >
          {{ t('preparation.actions.prepare') }}
        </AppButton>
      </template>
    </PageHeader>

    <AppInlineError v-if="error" :message="error" />

    <AppEmptyState
      v-if="!readiness || !readiness.available"
      :title="t('preparation.empty.title')"
      :description="t('preparation.empty.description')"
    />

    <template v-else>
      <!--
        §8.6 panel 1 — time coverage. It reports what was originally prepared for *and* what actually
        remains, as two separate facts. A historical success is never re-displayed as though the full
        window were still ahead.
      -->
      <article class="preparation-panel" data-testid="preparation-time-panel">
        <header class="preparation-panel__header">
          <h2>{{ t('preparation.time.title') }}</h2>
          <AppStatusChip :tone="timeChipTone">{{ timeHeadline }}</AppStatusChip>
        </header>

        <dl class="preparation-facts">
          <div>
            <dt>{{ t('preparation.time.preparedAt') }}</dt>
            <dd>{{ time?.preparedAt ? formatDateTime(time.preparedAt, locale.locale) : '—' }}</dd>
          </div>
          <div>
            <dt>{{ t('preparation.time.originallyPreparedFor') }}</dt>
            <dd>
              {{
                time?.requestedDurationSeconds
                  ? t('preparation.time.hours', {
                      hours: Math.round(time.requestedDurationSeconds / 3600)
                    })
                  : '—'
              }}
            </dd>
          </div>
          <div>
            <dt>{{ t('preparation.time.remainingLabel') }}</dt>
            <dd data-testid="preparation-remaining">{{ remainingText }}</dd>
          </div>
          <div>
            <dt>{{ t('preparation.time.supportedUntil') }}</dt>
            <dd>
              {{
                time?.effectiveReadyUntil
                  ? formatDateTime(time.effectiveReadyUntil, locale.locale)
                  : '—'
              }}
            </dd>
          </div>
          <div v-if="time?.limitingReason">
            <dt>{{ t('preparation.time.limitedBy') }}</dt>
            <!-- Every tied limiter is shown: §8.6 forbids hiding a simultaneous second one. -->
            <dd>
              {{
                (time.tiedLimitingReasons.length > 0
                  ? time.tiedLimitingReasons
                  : [time.limitingReason]
                )
                  .map(reasonText)
                  .join(t('common.listSeparator'))
              }}
            </dd>
          </div>
        </dl>

        <AppBanner v-if="time?.newlyObservedRestriction" tone="warning">
          {{
            t('preparation.time.newlyObserved', {
              reason: reasonText(time.newlyObservedRestriction)
            })
          }}
        </AppBanner>
      </article>

      <!--
        §8.6 panel 2 — quantity coverage. Deliberately separate from time: the quantity panel may
        read zero while time is non-zero, and that is an honest state, not a contradiction.
      -->
      <article class="preparation-panel" data-testid="preparation-quantity-panel">
        <header class="preparation-panel__header">
          <h2>{{ t('preparation.quantity.title') }}</h2>
          <AppStatusChip :tone="readiness.quantity.state === 'full' ? 'success' : 'warning'">
            {{ t(`preparation.quantity.state.${readiness.quantity.state}`) }}
          </AppStatusChip>
        </header>

        <table class="preparation-table">
          <thead>
            <tr>
              <th scope="col">{{ t('preparation.quantity.product') }}</th>
              <th scope="col">{{ t('preparation.quantity.usableNow') }}</th>
              <th scope="col">{{ t('preparation.quantity.coveredForWindow') }}</th>
              <th scope="col">{{ t('preparation.quantity.shortLived') }}</th>
              <th scope="col">{{ t('preparation.quantity.heldNotSpendable') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="product in products" :key="product.productUuid">
              <td>{{ product.productUuid }}</td>
              <td>{{ formatQuantity(product.usableNowMilli) }}</td>
              <td>{{ formatQuantity(product.coveredForWindowMilli) }}</td>
              <td>{{ formatQuantity(product.shortLivedMilli) }}</td>
              <td>{{ formatQuantity(product.heldNotSpendableMilli) }}</td>
            </tr>
          </tbody>
        </table>

        <p class="preparation-note">{{ t('preparation.quantity.note') }}</p>
      </article>

      <!--
        An operation that is ambiguous or awaiting replay is NEVER rendered as a successful
        preparation (§8.6). It is reported here, as unresolved, with its pending action.
      -->
      <AppBanner
        v-if="unresolvedOperations.length > 0"
        tone="warning"
        data-testid="preparation-unresolved"
      >
        {{ t('preparation.unresolved', { count: unresolvedOperations.length }) }}
      </AppBanner>

      <article v-if="blockedProducts.length > 0" class="preparation-panel">
        <h2>{{ t('preparation.blocked.title') }}</h2>
        <ul>
          <li v-for="blocked in blockedProducts" :key="blocked.productUuid">
            {{ blocked.productUuid }} — {{ blockedReasonText(blocked.reason) }}
          </li>
        </ul>
      </article>
    </template>
  </section>
</template>

<style scoped>
.preparation-page {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.preparation-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.25rem;
  border: 1px solid var(--color-border, #d8dee9);
  border-radius: 0.75rem;
}

.preparation-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.preparation-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 1rem;
}

.preparation-facts dt {
  font-size: 0.875rem;
  opacity: 0.75;
}

.preparation-facts dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.preparation-table {
  width: 100%;
  border-collapse: collapse;
}

.preparation-table th,
.preparation-table td {
  padding: 0.5rem;
  text-align: start;
  font-variant-numeric: tabular-nums;
}

.preparation-note {
  margin: 0;
  font-size: 0.875rem;
  opacity: 0.75;
}
</style>
