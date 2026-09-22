import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { SaleDetail, SalesInvoiceSummary } from '@shared/contracts/refund.contract'
import { SalesService } from './service'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'

export const useSalesStore = defineStore('sales', () => {
  const invoices = ref<SalesInvoiceSummary[]>([])
  const nextCursor = ref<string | null>(null)
  const search = ref('')
  const isLoading = ref(false)
  const detail = ref<SaleDetail | null>(null)
  const isLoadingDetail = ref(false)
  const errorRef = createLocalizedErrorRef()

  const hasMore = computed(() => nextCursor.value !== null)

  async function load(service: SalesService = new SalesService()): Promise<void> {
    isLoading.value = true
    errorRef.clear()

    try {
      const result = await service.listInvoices({
        search: search.value || undefined,
        limit: 25,
        cursor: null
      })
      invoices.value = [...result.invoices]
      nextCursor.value = result.nextCursor
    } catch (error) {
      const parsed = parsePublicAppError(error)
      if (parsed) {
        errorRef.setDetail(parsed)
      } else {
        errorRef.setFallbackKey('errors.generic')
      }
    } finally {
      isLoading.value = false
    }
  }

  async function loadMore(service: SalesService = new SalesService()): Promise<void> {
    if (!nextCursor.value || isLoading.value) {
      return
    }

    isLoading.value = true

    try {
      const result = await service.listInvoices({
        search: search.value || undefined,
        limit: 25,
        cursor: nextCursor.value
      })
      invoices.value = [...invoices.value, ...result.invoices]
      nextCursor.value = result.nextCursor
    } catch (error) {
      const parsed = parsePublicAppError(error)
      if (parsed) {
        errorRef.setDetail(parsed)
      }
    } finally {
      isLoading.value = false
    }
  }

  function applySearch(value: string, service?: SalesService): void {
    search.value = value
    void load(service)
  }

  async function loadDetail(
    invoiceLocalUuid: string,
    service: SalesService = new SalesService()
  ): Promise<void> {
    isLoadingDetail.value = true
    errorRef.clear()
    detail.value = null

    try {
      detail.value = await service.getInvoice(invoiceLocalUuid)
    } catch (error) {
      const parsed = parsePublicAppError(error)
      if (parsed) {
        errorRef.setDetail(parsed)
      } else {
        errorRef.setFallbackKey('errors.generic')
      }
    } finally {
      isLoadingDetail.value = false
    }
  }

  function clearDetail(): void {
    detail.value = null
  }

  return {
    invoices,
    nextCursor,
    hasMore,
    search,
    isLoading,
    detail,
    isLoadingDetail,
    error: errorRef.error,
    load,
    loadMore,
    applySearch,
    loadDetail,
    clearDetail
  }
})
