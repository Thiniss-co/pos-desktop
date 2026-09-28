<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useSalesStore } from '../store'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { formatMinorCurrency } from '@shared/money/minorUnits'
import { formatDateTime } from '@renderer/shared/utils/format'
import type { LocaleCode } from '@shared/contracts/preferences.contract'
import PageContainer from '@renderer/shared/components/layout/PageContainer.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import AppTable from '@renderer/shared/components/common/AppTable.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import SaleSyncChip from '../components/SaleSyncChip.vue'

const store = useSalesStore()
const { invoices, isLoading, hasMore, search, error } = storeToRefs(store)
const { t } = useI18n()
const localeStore = useLocaleStore()

/** The query the current list was loaded with — decides which empty state is honest. */
const appliedQuery = ref(search.value.trim())

onMounted(() => {
  void store.load()
})

function applySearch(): void {
  appliedQuery.value = search.value.trim()
  store.applySearch(search.value)
}

function clearSearch(): void {
  search.value = ''
  applySearch()
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

const legend = [
  {
    variant: 'success',
    icon: 'cloud_done',
    label: 'sales.syncSynced',
    body: 'sales.legendSynced'
  },
  {
    variant: 'information',
    icon: 'cloud_upload',
    label: 'sales.syncPending',
    body: 'sales.legendPending'
  },
  { variant: 'error', icon: 'error', label: 'sales.syncFailed', body: 'sales.legendFailed' }
] as const
</script>

<template>
  <PageContainer width="xl">
    <PageHeader :title="t('sales.title')" :description="t('sales.description')">
      <template #actions>
        <form
          role="search"
          class="flex w-full min-w-0 items-end gap-2 wide:w-105"
          @submit.prevent="applySearch"
        >
          <AppInput
            v-model="search"
            class="flex-1"
            :label="t('sales.searchLabel')"
            :placeholder="t('sales.searchPlaceholder')"
            inputmode="search"
          />
          <AppButton type="submit" variant="secondary" icon="search">
            {{ t('common.search') }}
          </AppButton>
        </form>
      </template>
    </PageHeader>

    <ul
      class="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted"
      :aria-label="t('sales.legendLabel')"
    >
      <li v-for="item in legend" :key="item.label" class="flex items-center gap-1.5">
        <AppStatusChip :variant="item.variant" :icon="item.icon" size="sm">{{
          t(item.label)
        }}</AppStatusChip>
        <span>{{ t(item.body) }}</span>
      </li>
    </ul>

    <AppBanner v-if="error" variant="error" role="alert" :title="t('sales.loadErrorTitle')">
      {{ error }}
      <template #action>
        <AppButton variant="secondary" size="sm" :disabled="isLoading" @click="store.load()">
          {{ t('common.retry') }}
        </AppButton>
      </template>
    </AppBanner>

    <AppPanel v-if="isLoading && invoices.length === 0">
      <AppLoadingSkeleton :label="t('common.loading')" :lines="6" />
    </AppPanel>

    <AppPanel v-else-if="invoices.length === 0 && !error" :padded="false">
      <AppEmptyState
        v-if="appliedQuery"
        icon="search_off"
        :title="t('sales.emptyFilteredTitle')"
        :description="t('sales.emptyFilteredBody')"
      >
        <template #action>
          <AppButton variant="secondary" @click="clearSearch">
            {{ t('sales.clearSearch') }}
          </AppButton>
        </template>
      </AppEmptyState>
      <AppEmptyState v-else icon="receipt_long" :title="t('sales.empty')" />
    </AppPanel>

    <AppTable v-else-if="invoices.length > 0" :label="t('sales.title')" :aria-busy="isLoading">
      <thead>
        <tr>
          <th scope="col">{{ t('sales.invoiceNumber') }}</th>
          <th scope="col" class="max-wide:hidden">{{ t('sales.soldAt') }}</th>
          <th scope="col" class="text-end!">{{ t('sales.total') }}</th>
          <th scope="col">{{ t('sales.colStatus') }}</th>
          <th scope="col">
            <span class="sr-only">{{ t('sales.colAction') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="invoice in invoices" :key="invoice.invoiceLocalUuid">
          <td class="min-w-0">
            <div class="code text-start text-sm font-semibold">{{ invoice.offlineNumber }}</div>
            <div v-if="invoice.serverNumber" class="code text-start text-xs text-muted">
              {{ invoice.serverNumber }}
            </div>
            <div v-else class="text-xs text-muted">{{ t('sales.noServerInvoice') }}</div>
          </td>
          <td class="numeric whitespace-nowrap max-wide:hidden">
            {{ soldAtLabel(invoice.soldAt) }}
          </td>
          <td class="numeric text-end font-bold whitespace-nowrap">
            {{ money(invoice.grandTotalAmount, invoice.currency, invoice.currencyExponent) }}
          </td>
          <td>
            <div class="flex flex-wrap gap-1.5">
              <SaleSyncChip :status="invoice.syncStatus" />
              <AppStatusChip v-if="invoice.hasOpenRefund" variant="warning" icon="hourglass_top">{{
                t('sales.hasOpenRefund')
              }}</AppStatusChip>
            </div>
          </td>
          <td class="text-end">
            <RouterLink
              :to="`/sales/${invoice.invoiceLocalUuid}`"
              class="inline-flex min-h-9 items-center justify-center rounded-md border border-control bg-surf px-3 text-sm font-semibold text-ink no-underline transition-colors hover:bg-subtle"
              :aria-label="t('sales.viewSaleLabel', { number: invoice.displayNumber })"
              >{{ t('common.view') }}</RouterLink
            >
          </td>
        </tr>
      </tbody>
    </AppTable>

    <div v-if="hasMore" class="flex justify-center">
      <AppButton
        variant="secondary"
        :disabled="isLoading"
        :loading="isLoading"
        @click="store.loadMore()"
      >
        {{ t('sales.loadMore') }}
      </AppButton>
    </div>
  </PageContainer>
</template>
