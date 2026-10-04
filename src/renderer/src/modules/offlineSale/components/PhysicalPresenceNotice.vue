<script setup lang="ts">
/**
 * Rev 4 §4.3 / A8 — the POS page's one readiness notice for physical-presence tills.
 *
 * Informational only. It never disables a card, the scan field or payment: main decides at commit
 * time (`clock-untrusted`, `offline-sale-authority-unavailable`) and the payment dialog explains a
 * refusal. This notice only tells the cashier *before* paying why an uncovered tracked sale would
 * wait, so a zero or negative stock figure is never mistaken for the reason.
 *
 * Readiness is re-read from main (never derived here) on mount, when connectivity changes, when a
 * checkout outcome arrives, and every 30 s while the page is open.
 */
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import { usePaymentStore } from '@renderer/modules/pos/payment.store'
import { useOfflineSaleStore } from '../store'

const REFRESH_MS = 30_000

const { t } = useI18n()
const offlineSale = useOfflineSaleStore()
const connectivity = useConnectivityStore()
const payment = usePaymentStore()

const notice = computed<'clock' | 'lapsed' | null>(() => {
  const readiness = offlineSale.readiness
  if (!readiness) {
    return null
  }
  if (readiness.clockUntrusted) {
    return 'clock'
  }
  return readiness.physicalPresenceLapsed ? 'lapsed' : null
})

let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void offlineSale.refresh()
  timer = setInterval(() => void offlineSale.refresh(), REFRESH_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer)
  }
})

watch(
  () => connectivity.snapshot?.status,
  () => void offlineSale.refresh()
)
watch(
  () => payment.completionOutcome,
  () => void offlineSale.refresh()
)
</script>

<template>
  <AppBanner
    v-if="notice === 'clock'"
    variant="warning"
    icon="lock_clock"
    role="status"
    data-testid="pp-notice-clock"
    :title="t('offlineSale.notice.clockTitle')"
  >
    {{ t('offlineSale.notice.clockBody') }}
  </AppBanner>
  <AppBanner
    v-else-if="notice === 'lapsed'"
    variant="info"
    icon="schedule"
    role="status"
    data-testid="pp-notice-lapsed"
    :title="t('offlineSale.notice.lapsedTitle')"
  >
    {{ t('offlineSale.notice.lapsedBody') }}
  </AppBanner>
</template>
