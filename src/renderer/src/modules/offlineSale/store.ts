import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { OfflineSaleReadiness } from '@shared/contracts/offlineSaleReadiness.contract'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { OfflineSaleService } from './service'

/**
 * PS6 §14.3 — offline-sell readiness for the operator surface.
 *
 * ## The countdown is never computed here
 *
 * `remainingSeconds` arrives from main, derived from **trusted** time against the authority's
 * immutable `not_after`. This store re-reads it; it never re-derives it from the wall clock and
 * never restarts it when a screen opens. A renderer clock is precisely how a window would appear to
 * reset on navigation — which §14.3 forbids.
 *
 * ## Readiness is not preparation
 *
 * There is deliberately no "prepare" action on this store. In `physical_presence` no stock
 * preparation is required, and offering a button that implied otherwise would misrepresent what
 * actually permits selling.
 */
export const useOfflineSaleStore = defineStore('offlineSale', () => {
  const readiness = ref<OfflineSaleReadiness | null>(null)
  const isLoading = ref(false)
  const errorState = createLocalizedErrorRef()
  const error = errorState.error

  const service = new OfflineSaleService()

  function captureError(caught: unknown, fallbackKey: string): void {
    const parsed = publicAppErrorSchema.safeParse(caught)

    if (parsed.success) {
      errorState.setDetail(parsed.data)

      return
    }

    errorState.setFallbackKey(fallbackKey)
  }

  async function refresh(): Promise<void> {
    isLoading.value = true

    try {
      readiness.value = await service.getReadiness()
      errorState.clear()
    } catch (caught) {
      captureError(caught, 'offlineSale.title')
    } finally {
      isLoading.value = false
    }
  }

  /** True only when main says so. Never inferred from the absence of an error or from stock. */
  const canSellWithoutQuota = computed(() => readiness.value?.canSellWithoutQuota === true)

  const isPhysicalPresence = computed(() => readiness.value?.mode === 'physical_presence')

  /**
   * Whether a non-blocking inventory warning should be shown.
   *
   * Deliberately independent of `canSellWithoutQuota`: the warning is information about the ledger,
   * never a gate on selling, and tying the two would let a display concern become a permission.
   */
  const hasInventoryWarning = computed(() => (readiness.value?.inventoryWarnings.length ?? 0) > 0)

  return {
    readiness,
    isLoading,
    error,
    refresh,
    canSellWithoutQuota,
    isPhysicalPresence,
    hasInventoryWarning
  }
})
