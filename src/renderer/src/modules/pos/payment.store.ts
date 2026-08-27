import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CheckoutIntent, CheckoutPreviewOutcome } from '@shared/contracts/checkout.contract'
import { parseMinorCurrencyInput, type MoneyInputResult } from '@shared/money/minorUnits'
import { handleRuntimeTransition } from '@renderer/app/session/runtimeTransition'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { CheckoutRendererService } from './checkout.service'

export interface PaymentDraftRow {
  readonly id: string
  readonly methodUuid: string
  readonly amount: number
  readonly reference: string | null
}

export type PaymentDraftErrorCode = Exclude<MoneyInputResult, { ok: true }>['code']

/**
 * A plain in-memory payment draft — no SQLite, no `localStorage`. `resetPayment` is the only way
 * rows disappear; closing the panel UI is a visibility toggle elsewhere and must never call it.
 */
export const usePaymentStore = defineStore('payment', () => {
  const rows = ref<PaymentDraftRow[]>([])
  const editingRowId = ref<string | null>(null)
  const activeMethodUuid = ref<string | null>(null)
  const draftAmountText = ref('')
  const draftReferenceText = ref('')
  const draftErrorCode = ref<PaymentDraftErrorCode | null>(null)
  const paymentRevision = ref(0)
  const contextGeneration = ref(0)
  const previewOutcome = ref<CheckoutPreviewOutcome | null>(null)
  const previewPending = ref(false)
  const previewErrorState = createLocalizedErrorRef()

  const paidTotalAmount = computed(() => rows.value.reduce((sum, row) => sum + row.amount, 0))
  const isEditingDraft = computed(() => activeMethodUuid.value !== null)
  const previewError = previewErrorState.error

  function currentToken(cartToken: string): string {
    return `${cartToken}:${paymentRevision.value}`
  }

  function bumpRevision(): void {
    paymentRevision.value += 1
    previewOutcome.value = null
    previewErrorState.clear()
  }

  function beginAddRow(methodUuid: string): void {
    editingRowId.value = null
    activeMethodUuid.value = methodUuid
    draftAmountText.value = ''
    draftReferenceText.value = ''
    draftErrorCode.value = null
  }

  function beginEditRow(rowId: string): void {
    const row = rows.value.find((candidate) => candidate.id === rowId)
    if (!row) {
      return
    }

    editingRowId.value = rowId
    activeMethodUuid.value = row.methodUuid
    draftReferenceText.value = row.reference ?? ''
    draftErrorCode.value = null
  }

  /** Minor-unit → decimal-string formatting is a currency-exponent concern the store does not own. */
  function setDraftAmountText(value: string): void {
    draftAmountText.value = value
    draftErrorCode.value = null
  }

  function setDraftReferenceText(value: string): void {
    draftReferenceText.value = value
  }

  function cancelDraftRow(): void {
    editingRowId.value = null
    activeMethodUuid.value = null
    draftAmountText.value = ''
    draftReferenceText.value = ''
    draftErrorCode.value = null
  }

  function commitDraftRow(currencyExponent: number): boolean {
    const methodUuid = activeMethodUuid.value
    if (!methodUuid) {
      return false
    }

    const parsed = parseMinorCurrencyInput(draftAmountText.value, currencyExponent)
    if (!parsed.ok) {
      draftErrorCode.value = parsed.code
      return false
    }

    const reference = draftReferenceText.value.trim() || null
    const editing = editingRowId.value

    rows.value = editing
      ? rows.value.map((row) =>
          row.id === editing ? { ...row, amount: parsed.value, reference } : row
        )
      : [...rows.value, { id: crypto.randomUUID(), methodUuid, amount: parsed.value, reference }]

    cancelDraftRow()
    bumpRevision()
    return true
  }

  function removeRow(rowId: string): void {
    const nextRows = rows.value.filter((row) => row.id !== rowId)
    if (nextRows.length === rows.value.length) {
      return
    }

    rows.value = nextRows
    if (editingRowId.value === rowId) {
      cancelDraftRow()
    }
    bumpRevision()
  }

  /** Logout, session/device recovery, company/cashier/shift change, and `cart.resetDraft`. */
  function resetPayment(): void {
    contextGeneration.value += 1
    rows.value = []
    cancelDraftRow()
    paymentRevision.value += 1
    previewOutcome.value = null
    previewPending.value = false
    previewErrorState.clear()
  }

  async function refreshPreview(
    getCartToken: () => string,
    intent: CheckoutIntent,
    service: Pick<CheckoutRendererService, 'validate'> = new CheckoutRendererService()
  ): Promise<void> {
    const issuedToken = currentToken(getCartToken())
    previewPending.value = true

    try {
      const outcome = await service.validate(intent)
      if (issuedToken !== currentToken(getCartToken())) {
        return
      }

      previewOutcome.value = outcome
      previewErrorState.clear()
    } catch (cause) {
      if (issuedToken !== currentToken(getCartToken())) {
        return
      }

      previewOutcome.value = null
      const publicError = parsePublicAppError(cause)

      if (publicError) {
        void handleRuntimeTransition(publicError)
        previewErrorState.setDetail(publicError)
      } else {
        previewErrorState.setFallbackKey('pos.payment.previewUnavailable')
      }
    } finally {
      if (issuedToken === currentToken(getCartToken())) {
        previewPending.value = false
      }
    }
  }

  return {
    rows,
    editingRowId,
    activeMethodUuid,
    draftAmountText,
    draftReferenceText,
    draftErrorCode,
    paymentRevision,
    contextGeneration,
    previewOutcome,
    previewPending,
    previewError,
    paidTotalAmount,
    isEditingDraft,
    beginAddRow,
    beginEditRow,
    setDraftAmountText,
    setDraftReferenceText,
    cancelDraftRow,
    commitDraftRow,
    removeRow,
    resetPayment,
    refreshPreview
  }
})
