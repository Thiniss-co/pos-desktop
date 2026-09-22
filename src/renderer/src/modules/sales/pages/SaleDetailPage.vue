<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { useSalesStore } from '../store'
import { useRefundsStore } from '@renderer/modules/refunds/store'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { formatMinorCurrency } from '@shared/money/minorUnits'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppTable from '@renderer/shared/components/common/AppTable.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import RefundDialog from '@renderer/modules/refunds/components/RefundDialog.vue'

/**
 * Plan §6 -- exact location of the refund action: a "Return / Refund" button in this page's
 * `PageHeader` `actions` slot, opening `RefundDialog`. An OPEN local refund (prepared, dispatched,
 * unresolved, or conflict) is surfaced with its own banner and resume/discard controls, and blocks
 * starting a second refund on this sale -- the durable overlap invariant is enforced main-side
 * (plan §3a); this UI simply reflects it.
 */
const route = useRoute()
const invoiceLocalUuid = computed(() => String(route.params.localUuid))

const salesStore = useSalesStore()
const { detail, isLoadingDetail, error } = storeToRefs(salesStore)
const refundsStore = useRefundsStore()
const { isSubmitting } = storeToRefs(refundsStore)

const localeStore = useLocaleStore()
const { t } = useI18n()

const dialogOpen = ref(false)

onMounted(() => {
  void salesStore.loadDetail(invoiceLocalUuid.value)
})

function money(amount: number): string {
  const currency = detail.value?.invoice.currency
  const exponent = detail.value?.invoice.currencyExponent ?? 2
  if (!currency) return String(amount)
  const formatted = formatMinorCurrency(
    amount,
    localeStore.locale as LocaleCode,
    currency,
    exponent
  )
  return formatted.ok ? formatted.value : '—'
}

function openRefundDialog(): void {
  dialogOpen.value = true
}

function closeRefundDialog(): void {
  dialogOpen.value = false
  void salesStore.loadDetail(invoiceLocalUuid.value)
}

async function resumeOpenRefund(): Promise<void> {
  if (!detail.value?.openRefund) return
  await refundsStore.resume(detail.value.openRefund.localUuid)
  void salesStore.loadDetail(invoiceLocalUuid.value)
}

async function discardOpenRefund(): Promise<void> {
  if (!detail.value?.openRefund) return
  await refundsStore.cancelPrepared(detail.value.openRefund.localUuid)
  void salesStore.loadDetail(invoiceLocalUuid.value)
}

const canOpenNewRefund = computed(() => detail.value !== null && detail.value.openRefund === null)
</script>

<template>
  <div class="sale-detail-page">
    <RouterLink to="/sales">{{ t('sales.backToList') }}</RouterLink>

    <AppLoadingSkeleton v-if="isLoadingDetail" :label="t('common.loading')" :lines="6" />

    <AppBanner v-else-if="error" variant="error" role="alert">{{ error }}</AppBanner>

    <template v-else-if="detail">
      <PageHeader
        :eyebrow="t('sales.eyebrow')"
        :title="t('sales.detailTitle', { number: detail.invoice.displayNumber })"
        :description="detail.invoice.soldAt"
      >
        <template #actions>
          <AppButton v-if="canOpenNewRefund" variant="transaction" @click="openRefundDialog">
            {{ t('sales.returnAction') }}
          </AppButton>
        </template>
      </PageHeader>

      <AppBanner
        v-if="detail.openRefund?.submissionState === 'conflict'"
        variant="error"
        role="alert"
      >
        <strong>{{ t('refunds.conflictNotice') }}</strong>
        <p class="numeric">{{ detail.openRefund.localUuid }}</p>
      </AppBanner>

      <AppBanner
        v-else-if="
          detail.openRefund?.submissionState === 'unresolved' ||
          detail.openRefund?.submissionState === 'prepared'
        "
        variant="warning"
        role="alert"
      >
        <strong>{{ t('refunds.pendingUnresolved') }}</strong>
        <template #action>
          <AppButton
            v-if="detail.openRefund.submissionState === 'unresolved'"
            variant="secondary"
            :disabled="isSubmitting"
            :loading="isSubmitting"
            @click="resumeOpenRefund"
          >
            {{ t('refunds.resumeAction') }}
          </AppButton>
          <AppButton
            v-if="detail.openRefund.submissionState === 'prepared'"
            variant="ghost"
            @click="discardOpenRefund"
          >
            {{ t('refunds.cancelPreparedAction') }}
          </AppButton>
        </template>
      </AppBanner>

      <AppBanner v-else-if="detail.openRefund?.submissionState === 'dispatched'" variant="info">
        {{ t('refunds.submitting') }}
      </AppBanner>

      <dl class="sale-detail-page__summary">
        <div>
          <dt>{{ t('sales.total') }}</dt>
          <dd class="numeric">{{ money(detail.invoice.grandTotalAmount) }}</dd>
        </div>
      </dl>

      <h2>{{ t('sales.items') }}</h2>
      <AppTable>
        <thead>
          <tr>
            <th scope="col">{{ t('refunds.productName') }}</th>
            <th scope="col">{{ t('refunds.quantitySold') }}</th>
            <th scope="col">{{ t('sales.total') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.items" :key="item.localUuid">
            <td>{{ item.productName }}</td>
            <td class="numeric">{{ (item.quantityMilli / 1000).toFixed(3) }}</td>
            <td class="numeric">{{ money(item.totalAmount) }}</td>
          </tr>
        </tbody>
      </AppTable>

      <h2>{{ t('sales.refundHistory') }}</h2>
      <p v-if="detail.refunds.length === 0">{{ t('sales.noRefunds') }}</p>
      <AppTable v-else>
        <thead>
          <tr>
            <th scope="col">{{ t('sales.total') }}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="refund in detail.refunds" :key="refund.localUuid">
            <td class="numeric">{{ refund.grandTotalAmount }}</td>
            <td>
              <AppStatusChip>{{ refund.submissionState }}</AppStatusChip>
            </td>
          </tr>
        </tbody>
      </AppTable>

      <RefundDialog
        :open="dialogOpen"
        :invoice-local-uuid="invoiceLocalUuid"
        @close="closeRefundDialog"
      />
    </template>
  </div>
</template>

<style scoped>
.sale-detail-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
}

.sale-detail-page__summary {
  display: flex;
  gap: var(--space-6);
}

@media (max-width: 480px) {
  .sale-detail-page {
    padding: var(--space-4);
    gap: var(--space-3);
  }
}
</style>
