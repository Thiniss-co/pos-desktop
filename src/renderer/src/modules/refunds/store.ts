import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  RefundableInvoice,
  RefundLineSelection,
  RefundOutcome,
  RefundPreview
} from '@shared/contracts/refund.contract'
import { RefundsService } from './service'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'

/**
 * Plan §5/§6 -- the refund flow's renderer-side state.
 *
 * `isSubmitting` is the double-click / rapid-repeat guard: `submit()` is a no-op while it is true.
 * It is advisory only -- the durable guard against overlapping operations is the backend's
 * idempotency identity plus the local `idx_local_refunds_one_open` invariant (plan §3a); this flag
 * exists so the UI never even offers a second click.
 */
export const useRefundsStore = defineStore('refunds', () => {
  const invoiceLocalUuid = ref<string | null>(null)
  const refundable = ref<RefundableInvoice | null>(null)
  const isLoadingRefundable = ref(false)

  const selection = reactive(new Map<string, number>())
  const stockReturned = ref(true)
  const paymentMethodUuid = ref<string | null>(null)
  const reference = ref('')
  const reason = ref('')
  const notes = ref('')

  const preview = ref<RefundPreview | null>(null)
  const isPreviewing = ref(false)

  const outcome = ref<RefundOutcome | null>(null)
  const isSubmitting = ref(false)

  const errorRef = createLocalizedErrorRef()

  const selectedLines = computed<RefundLineSelection[]>(() =>
    Array.from(selection.entries())
      .filter(([, milli]) => milli > 0)
      .map(([invoiceItemRemoteUuid, quantityMilli]) => ({ invoiceItemRemoteUuid, quantityMilli }))
  )

  const hasSelection = computed(() => selectedLines.value.length > 0)

  function reportError(error: unknown, fallbackKey = 'errors.generic'): void {
    const parsed = parsePublicAppError(error)
    if (parsed) {
      errorRef.setDetail(parsed)
    } else {
      errorRef.setFallbackKey(fallbackKey)
    }
  }

  async function openForInvoice(
    nextInvoiceLocalUuid: string,
    service: RefundsService = new RefundsService()
  ): Promise<void> {
    invoiceLocalUuid.value = nextInvoiceLocalUuid
    refundable.value = null
    selection.clear()
    preview.value = null
    outcome.value = null
    errorRef.clear()
    isLoadingRefundable.value = true

    try {
      refundable.value = await service.getRefundable(nextInvoiceLocalUuid)
    } catch (error) {
      reportError(error)
    } finally {
      isLoadingRefundable.value = false
    }
  }

  function setLineQuantity(invoiceItemRemoteUuid: string, quantityMilli: number): void {
    if (quantityMilli <= 0) {
      selection.delete(invoiceItemRemoteUuid)
      return
    }
    selection.set(invoiceItemRemoteUuid, quantityMilli)
    // A selection change invalidates any prior preview (plan §1 "stale preview").
    preview.value = null
  }

  function setStockReturned(value: boolean): void {
    stockReturned.value = value
    preview.value = null
  }

  async function requestPreview(service: RefundsService = new RefundsService()): Promise<void> {
    if (!invoiceLocalUuid.value || !hasSelection.value) {
      return
    }

    isPreviewing.value = true
    errorRef.clear()

    try {
      preview.value = await service.preview({
        invoiceLocalUuid: invoiceLocalUuid.value,
        lines: selectedLines.value,
        stockReturned: stockReturned.value
      })
    } catch (error) {
      preview.value = null
      reportError(error)
    } finally {
      isPreviewing.value = false
    }
  }

  /** The double-click / rapid-repeat guard (plan §5): a no-op while a submission is in flight. */
  async function submit(service: RefundsService = new RefundsService()): Promise<void> {
    if (isSubmitting.value || !preview.value || !invoiceLocalUuid.value) {
      return
    }

    isSubmitting.value = true
    errorRef.clear()

    try {
      outcome.value = await service.submit({
        previewId: preview.value.previewId,
        invoiceLocalUuid: invoiceLocalUuid.value,
        lines: selectedLines.value,
        stockReturned: stockReturned.value,
        paymentMethodUuid: paymentMethodUuid.value,
        reference: reference.value || null,
        reason: reason.value || null,
        notes: notes.value || null
      })
    } catch (error) {
      reportError(error)
    } finally {
      isSubmitting.value = false
    }
  }

  async function resume(
    localRefundUuid: string,
    service: RefundsService = new RefundsService()
  ): Promise<void> {
    if (isSubmitting.value) {
      return
    }

    isSubmitting.value = true
    errorRef.clear()

    try {
      outcome.value = await service.resume(localRefundUuid)
    } catch (error) {
      reportError(error)
    } finally {
      isSubmitting.value = false
    }
  }

  async function cancelPrepared(
    localRefundUuid: string,
    service: RefundsService = new RefundsService()
  ): Promise<boolean> {
    try {
      const result = await service.cancelPrepared(localRefundUuid)
      return result.cancelled
    } catch (error) {
      reportError(error)
      return false
    }
  }

  function reset(): void {
    invoiceLocalUuid.value = null
    refundable.value = null
    selection.clear()
    preview.value = null
    outcome.value = null
    stockReturned.value = true
    paymentMethodUuid.value = null
    reference.value = ''
    reason.value = ''
    notes.value = ''
    errorRef.clear()
  }

  return {
    invoiceLocalUuid,
    refundable,
    isLoadingRefundable,
    selection,
    selectedLines,
    hasSelection,
    stockReturned,
    paymentMethodUuid,
    reference,
    reason,
    notes,
    preview,
    isPreviewing,
    outcome,
    isSubmitting,
    error: errorRef.error,
    openForInvoice,
    setLineQuantity,
    setStockReturned,
    requestPreview,
    submit,
    resume,
    cancelPrepared,
    reset
  }
})
