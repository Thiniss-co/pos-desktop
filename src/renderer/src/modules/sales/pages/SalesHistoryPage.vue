<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useSalesStore } from '../store'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { formatMinorCurrency } from '@shared/money/minorUnits'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import AppTable from '@renderer/shared/components/common/AppTable.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'

const store = useSalesStore()
const { invoices, isLoading, hasMore, search, error } = storeToRefs(store)
const { t } = useI18n()
const localeStore = useLocaleStore()

onMounted(() => {
  void store.load()
})

function applySearch(): void {
  store.applySearch(search.value)
}

function money(amount: number, currency: string, exponent: number): string {
  const formatted = formatMinorCurrency(
    amount,
    localeStore.locale as LocaleCode,
    currency,
    exponent
  )
  return formatted.ok ? formatted.value : '—'
}

function syncLabel(status: string): string {
  if (status === 'synced') return t('sales.syncSynced')
  if (status === 'rejected' || status === 'conflict') return t('sales.syncFailed')
  return t('sales.syncPending')
}

function syncVariant(status: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (status === 'synced') return 'success'
  if (status === 'rejected' || status === 'conflict') return 'error'
  return 'warning'
}
</script>

<template>
  <div class="sales-page">
    <PageHeader
      :eyebrow="t('sales.eyebrow')"
      :title="t('sales.title')"
      :description="t('sales.description')"
    />

    <AppInput
      v-model="search"
      :label="t('sales.searchLabel')"
      :placeholder="t('sales.searchPlaceholder')"
      @keydown.enter="applySearch"
    />
    <AppButton variant="secondary" @click="applySearch">{{ t('common.search') }}</AppButton>

    <AppInlineError v-if="error">{{ error }}</AppInlineError>

    <AppLoadingSkeleton
      v-if="isLoading && invoices.length === 0"
      :label="t('common.loading')"
      :lines="5"
    />

    <AppEmptyState v-else-if="invoices.length === 0" :title="t('sales.empty')" />

    <AppTable v-else>
      <thead>
        <tr>
          <th scope="col">{{ t('sales.invoiceNumber') }}</th>
          <th scope="col">{{ t('sales.soldAt') }}</th>
          <th scope="col">{{ t('sales.total') }}</th>
          <th scope="col"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="invoice in invoices" :key="invoice.invoiceLocalUuid">
          <td class="numeric">{{ invoice.displayNumber }}</td>
          <td class="numeric">{{ invoice.soldAt }}</td>
          <td class="numeric">
            {{ money(invoice.grandTotalAmount, invoice.currency, invoice.currencyExponent) }}
          </td>
          <td>
            <AppStatusChip :variant="syncVariant(invoice.syncStatus)">{{
              syncLabel(invoice.syncStatus)
            }}</AppStatusChip>
            <AppStatusChip v-if="invoice.hasOpenRefund" variant="warning">{{
              t('sales.hasOpenRefund')
            }}</AppStatusChip>
            <RouterLink :to="`/sales/${invoice.invoiceLocalUuid}`">{{
              t('common.view')
            }}</RouterLink>
          </td>
        </tr>
      </tbody>
    </AppTable>

    <AppButton v-if="hasMore" variant="ghost" :disabled="isLoading" @click="store.loadMore()">
      {{ t('sales.loadMore') }}
    </AppButton>
  </div>
</template>

<style scoped>
.sales-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
}

@media (max-width: 480px) {
  .sales-page {
    padding: var(--space-4);
    gap: var(--space-3);
  }
}
</style>
