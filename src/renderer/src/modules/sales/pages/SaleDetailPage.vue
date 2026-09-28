<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { useSalesStore } from '../store'
import { useRefundsStore } from '@renderer/modules/refunds/store'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { formatMinorCurrency } from '@shared/money/minorUnits'
import { formatDateTime, formatNumber } from '@renderer/shared/utils/format'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import type { RefundSubmissionState } from '@shared/contracts/refund.contract'
import PageContainer from '@renderer/shared/components/layout/PageContainer.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppIconButton from '@renderer/shared/components/common/AppIconButton.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
import AppTable from '@renderer/shared/components/common/AppTable.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import RefundDialog from '@renderer/modules/refunds/components/RefundDialog.vue'
import ReceiptPreviewDialog from '@renderer/modules/printing/components/ReceiptPreviewDialog.vue'
import type { ReceiptDocumentRef } from '@shared/contracts/printing.contract'
import SaleSyncChip from '../components/SaleSyncChip.vue'

/**
 * Plan §6 -- exact location of the refund action: a "Refund items" button in this page's
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
const { t, te } = useI18n()

const dialogOpen = ref(false)

const receiptDialogOpen = ref(false)
const receiptDocument = ref<ReceiptDocumentRef | null>(null)

function printSaleReceipt(): void {
  receiptDocument.value = { kind: 'sale', invoiceLocalUuid: invoiceLocalUuid.value }
  receiptDialogOpen.value = true
}

function printRefundReceipt(refundLocalUuid: string): void {
  receiptDocument.value = { kind: 'refund', refundLocalUuid }
  receiptDialogOpen.value = true
}

function closeReceiptDialog(): void {
  receiptDialogOpen.value = false
}

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

function quantity(quantityMilli: number): string {
  return formatNumber(quantityMilli / 1000, localeStore.locale as LocaleCode, {
    maximumFractionDigits: 3
  })
}

function soldAtLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return formatDateTime(date, localeStore.locale as LocaleCode, {
    dateStyle: 'medium',
    timeStyle: 'short',
    numberingSystem: 'latn'
  })
}

function paymentLabel(type: string): string {
  const key = `sales.paymentType.${type}`
  return te(key) ? t(key) : type
}

const REFUND_STATE_TONE: Record<
  RefundSubmissionState,
  { variant: 'success' | 'warning' | 'error' | 'information' | 'neutral'; icon: IconName }
> = {
  prepared: { variant: 'neutral', icon: 'pending' },
  dispatched: { variant: 'information', icon: 'hourglass_top' },
  unresolved: { variant: 'warning', icon: 'help' },
  accepted: { variant: 'success', icon: 'check_circle' },
  rejected: { variant: 'neutral', icon: 'block' },
  conflict: { variant: 'error', icon: 'sync_problem' },
  cancelled: { variant: 'neutral', icon: 'cancel' }
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
  <PageContainer width="xl">
    <RouterLink
      to="/sales"
      class="inline-flex min-h-9 items-center gap-1 self-start rounded-md px-2 text-sm font-semibold text-pri-text no-underline hover:bg-subtle"
    >
      <AppIcon name="arrow_back" :size="20" mirror-rtl />
      {{ t('sales.backToList') }}
    </RouterLink>

    <AppPanel v-if="isLoadingDetail">
      <AppLoadingSkeleton :label="t('common.loading')" :lines="6" />
    </AppPanel>

    <AppBanner v-else-if="error" variant="error" role="alert">{{ error }}</AppBanner>

    <template v-else-if="detail">
      <PageHeader :title="t('sales.detailTitle', { number: detail.invoice.displayNumber })">
        <template #badge>
          <SaleSyncChip :status="detail.invoice.syncStatus" />
        </template>
        <template #meta>
          <p class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-muted">
            <span class="numeric">{{
              t('sales.soldAtMeta', { when: soldAtLabel(detail.invoice.soldAt) })
            }}</span>
            <span v-if="detail.invoice.serverNumber">
              {{ t('sales.serverInvoice') }}
              <span class="code text-ink">{{ detail.invoice.serverNumber }}</span>
            </span>
            <span v-else>{{ t('sales.noServerInvoice') }}</span>
          </p>
        </template>
        <template #actions>
          <AppButton variant="secondary" icon="print" @click="printSaleReceipt">
            {{ t('sales.printAction') }}
          </AppButton>
          <AppButton
            v-if="canOpenNewRefund"
            variant="primary"
            icon="undo"
            @click="openRefundDialog"
          >
            {{ t('sales.refundItemsAction') }}
          </AppButton>
        </template>
      </PageHeader>

      <AppBanner
        v-if="detail.openRefund?.submissionState === 'conflict'"
        variant="error"
        role="alert"
        icon="sync_problem"
      >
        <p>{{ t('refunds.conflictNotice') }}</p>
        <p class="mt-1 text-muted">
          {{ t('refunds.supportReference') }}:
          <span class="code font-semibold text-ink">{{ detail.openRefund.localUuid }}</span>
        </p>
      </AppBanner>

      <AppBanner
        v-else-if="
          detail.openRefund?.submissionState === 'unresolved' ||
          detail.openRefund?.submissionState === 'prepared'
        "
        variant="warning"
        role="alert"
        icon="help"
      >
        {{ t('refunds.pendingUnresolved') }}
        <template #action>
          <AppButton
            v-if="detail.openRefund.submissionState === 'unresolved'"
            variant="secondary"
            size="sm"
            :disabled="isSubmitting"
            :loading="isSubmitting"
            @click="resumeOpenRefund"
          >
            {{ t('refunds.resumeAction') }}
          </AppButton>
          <AppButton
            v-if="detail.openRefund.submissionState === 'prepared'"
            variant="ghost"
            size="sm"
            @click="discardOpenRefund"
          >
            {{ t('refunds.cancelPreparedAction') }}
          </AppButton>
        </template>
      </AppBanner>

      <AppBanner
        v-else-if="detail.openRefund?.submissionState === 'dispatched'"
        variant="info"
        icon="hourglass_top"
      >
        {{ t('refunds.submitting') }}
      </AppBanner>

      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))] items-start gap-4">
        <AppPanel :padded="false" class="overflow-hidden">
          <template #header>
            <div class="flex items-baseline gap-2">
              <h2 class="text-lg font-bold">{{ t('sales.items') }}</h2>
              <span class="numeric text-xs text-muted">{{
                t('sales.productsCount', { n: detail.items.length }, detail.items.length)
              }}</span>
            </div>
          </template>
          <AppTable :framed="false" :label="t('sales.items')">
            <thead>
              <tr>
                <th scope="col">{{ t('refunds.productName') }}</th>
                <th scope="col" class="text-center!">{{ t('refunds.quantitySold') }}</th>
                <th scope="col" class="text-end!">{{ t('sales.unitPrice') }}</th>
                <th scope="col" class="text-end!">{{ t('sales.amount') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in detail.items" :key="item.localUuid">
                <td class="min-w-0">
                  <div class="font-medium">{{ item.productName }}</div>
                  <div v-if="item.sku" class="code text-start text-xs text-muted">
                    {{ item.sku }}
                  </div>
                </td>
                <td class="numeric text-center font-semibold">
                  {{ quantity(item.quantityMilli) }}
                </td>
                <td class="numeric text-end whitespace-nowrap">
                  {{ money(item.unitPriceAmount) }}
                </td>
                <td class="numeric text-end font-bold whitespace-nowrap">
                  {{ money(item.totalAmount) }}
                </td>
              </tr>
            </tbody>
          </AppTable>
        </AppPanel>

        <div class="flex min-w-0 flex-col gap-4">
          <AppPanel :title="t('sales.totals')">
            <dl class="numeric flex items-baseline justify-between gap-3">
              <dt class="font-bold">{{ t('sales.total') }}</dt>
              <dd class="text-3xl font-extrabold">{{ money(detail.invoice.grandTotalAmount) }}</dd>
            </dl>
          </AppPanel>

          <AppPanel :title="t('sales.payments')">
            <p v-if="detail.payments.length === 0" class="text-sm text-muted">
              {{ t('sales.noPayments') }}
            </p>
            <ul v-else class="flex flex-col gap-2 text-sm">
              <li
                v-for="payment in detail.payments"
                :key="payment.localUuid"
                class="flex justify-between gap-2.5"
              >
                <span class="min-w-0">
                  {{ paymentLabel(payment.type) }}
                  <template v-if="payment.reference">
                    ·
                    <span class="code text-xs text-muted">{{ payment.reference }}</span>
                  </template>
                </span>
                <span class="numeric font-semibold whitespace-nowrap">{{
                  money(payment.amount)
                }}</span>
              </li>
            </ul>
          </AppPanel>

          <AppPanel :title="t('sales.refundHistory')">
            <p v-if="detail.refunds.length === 0" class="text-sm text-muted">
              {{ t('sales.noRefunds') }}
            </p>
            <ul v-else class="flex flex-col gap-2.5">
              <li
                v-for="refund in detail.refunds"
                :key="refund.localUuid"
                class="flex flex-wrap items-center gap-2.5 rounded-notice border border-line px-3 py-2.5 text-sm"
              >
                <div class="min-w-35 flex-1">
                  <div class="code text-start font-semibold">{{ refund.refundNumber ?? '—' }}</div>
                  <div class="numeric text-xs text-muted">
                    {{ money(refund.grandTotalAmount) }}
                  </div>
                </div>
                <AppStatusChip
                  :variant="REFUND_STATE_TONE[refund.submissionState].variant"
                  :icon="REFUND_STATE_TONE[refund.submissionState].icon"
                  >{{ t(`sales.refundState.${refund.submissionState}`) }}</AppStatusChip
                >
                <AppIconButton
                  v-if="refund.submissionState === 'accepted'"
                  variant="outline"
                  icon="print"
                  :label="t('sales.printRefundAction')"
                  @click="printRefundReceipt(refund.localUuid)"
                />
              </li>
            </ul>
          </AppPanel>
        </div>
      </div>

      <RefundDialog
        :open="dialogOpen"
        :invoice-local-uuid="invoiceLocalUuid"
        @close="closeRefundDialog"
      />

      <ReceiptPreviewDialog
        :open="receiptDialogOpen"
        :document="receiptDocument"
        @close="closeReceiptDialog"
      />
    </template>
  </PageContainer>
</template>
