import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CheckoutCompletionOutcome,
  CheckoutIntent,
  CheckoutPreviewOutcome,
  CheckoutRecoveryState
} from '@shared/contracts/checkout.contract'
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
 * A plain in-memory payment draft — no SQLite, no `localStorage`. Rows disappear only when the
 * draft is deliberately ended: `resetPayment` (owner-context change) or acknowledging this draft's
 * own committed sale. Closing the panel UI is a visibility toggle elsewhere and must never do it.
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

  // --- Phase 3F CP-4: completion/recovery state -------------------------------------------------
  // `attemptKey` is the renderer-generated idempotency key for the *current* draft's checkout
  // attempt — created once on the first `complete()` call and reused for every retry of that same
  // draft; a definite rejection (T3) or a successful acknowledge frees it so a genuinely new sale
  // gets a genuinely new key (plan §1.1/§2.2).
  const attemptKey = ref<string | null>(null)
  const completionPending = ref(false)
  const completionOutcome = ref<CheckoutCompletionOutcome | null>(null)
  const completionErrorState = createLocalizedErrorRef()
  const blockingAttemptKey = ref<string | null>(null)
  const pendingResults = ref<CheckoutRecoveryState['unacknowledgedResults']>([])
  let activeCompletionRequest: symbol | null = null

  const paidTotalAmount = computed(() => rows.value.reduce((sum, row) => sum + row.amount, 0))
  const isEditingDraft = computed(() => activeMethodUuid.value !== null)
  const previewError = previewErrorState.error
  const completionError = completionErrorState.error
  const isBlocked = computed(() => blockingAttemptKey.value !== null)

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

  /**
   * The tender draft belongs to exactly one sale. Clears the rows, any half-typed row and the now
   * meaningless preview, without touching `contextGeneration` or the recovery lists — this ends a
   * draft, it does not change who owns the till.
   */
  function clearDraft(): void {
    rows.value = []
    cancelDraftRow()
    paymentRevision.value += 1
    previewOutcome.value = null
    previewPending.value = false
    previewErrorState.clear()
  }

  /** Logout, session/device recovery, company/cashier/shift change, and `cart.resetDraft`. */
  function resetPayment(): void {
    contextGeneration.value += 1
    clearDraft()
    attemptKey.value = null
    completionPending.value = false
    activeCompletionRequest = null
    completionOutcome.value = null
    completionErrorState.clear()
    // `resetPayment` fires on every owner-context change this store knows about (logout, session/
    // device recovery, cashier/company/shift change), so recovery state is cleared here rather than
    // conditionally preserved — main's `pendingAttempts()` is owner-scoped and re-derives the
    // correct answer for whoever is current from scratch; the caller is responsible for calling
    // `discoverPending()` again once the new owner context is established.
    blockingAttemptKey.value = null
    pendingResults.value = []
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

  /**
   * `checkout:complete` (T1 → T2/T3). Reuses the same renderer-generated `attemptKey` across
   * retries of the *same* draft; a definite rejection tombstones it (plan §2.2: a corrected sale
   * requires a new key). Cart-clearing on success is the caller's responsibility (`onCommitted`) —
   * this store never imports `cart.store.ts` directly, matching `refreshPreview`'s existing
   * `getCartToken` callback pattern. A late response (the draft/session moved on while this call was
   * in flight) is dropped silently, never applied — plan §2.10.
   */
  async function complete(
    getCartToken: () => string,
    intent: CheckoutIntent,
    onCommitted: () => void,
    service: Pick<CheckoutRendererService, 'complete'> = new CheckoutRendererService()
  ): Promise<void> {
    if (
      activeCompletionRequest !== null ||
      completionOutcome.value?.outcome === 'committed' ||
      completionOutcome.value?.outcome === 'acknowledged'
    ) {
      return
    }

    if (!attemptKey.value) {
      attemptKey.value = crypto.randomUUID()
    }
    const key = attemptKey.value
    const issuedToken = currentToken(getCartToken())
    const request = Symbol('checkout-completion')
    activeCompletionRequest = request
    completionPending.value = true
    completionErrorState.clear()

    try {
      const outcome = await service.complete(key, intent)
      if (issuedToken !== currentToken(getCartToken())) {
        return
      }

      completionOutcome.value = outcome
      completionErrorState.clear()

      if (outcome.outcome === 'committed') {
        onCommitted()
      } else if (outcome.outcome === 'rejected') {
        // T3: this exact key can never become a sale again. A corrected cart needs a new key.
        attemptKey.value = null
      } else if (outcome.outcome === 'failed' && outcome.code === 'attempt-blocked') {
        blockingAttemptKey.value = outcome.blockingAttemptKey ?? null
      }
    } catch (cause) {
      if (issuedToken !== currentToken(getCartToken())) {
        return
      }

      completionOutcome.value = null
      const publicError = parsePublicAppError(cause)

      if (publicError) {
        void handleRuntimeTransition(publicError)
        completionErrorState.setDetail(publicError)
      } else {
        completionErrorState.setFallbackKey('pos.payment.completion.unavailable')
      }
    } finally {
      // The committed callback intentionally clears the cart, which changes `issuedToken`. Busy
      // state belongs to this request, not to the draft token: only a reset/newer request may take
      // ownership away, and the request that still owns it must always release it.
      if (activeCompletionRequest === request) {
        activeCompletionRequest = null
        completionPending.value = false
      }
    }
  }

  /**
   * `checkout:retry-attempt` (T4), key-only. Never touches the active cart draft — this is used
   * both for the current draft's blocked key and for an unrelated recovery-banner attempt from a
   * previous crash, where no corresponding cart draft may even exist any more.
   */
  async function retryAttempt(
    key: string,
    service: Pick<CheckoutRendererService, 'retryAttempt'> = new CheckoutRendererService()
  ): Promise<CheckoutCompletionOutcome> {
    const issuedGeneration = contextGeneration.value
    const outcome = await service.retryAttempt(key)
    // A logout/device-recovery/cashier change while this call was in flight must never let its
    // result apply to whoever the current owner is now (plan §2.10: late responses never apply to
    // a newer session).
    if (contextGeneration.value !== issuedGeneration) {
      return outcome
    }

    completionOutcome.value = outcome

    if (outcome.outcome === 'committed' && blockingAttemptKey.value === key) {
      blockingAttemptKey.value = null
    }

    return outcome
  }

  /** `checkout:abandon-attempt` (T5, D1-A) — no `pos.sell`/open-shift/commercial-access required. */
  async function abandonAttempt(
    key: string,
    service: Pick<CheckoutRendererService, 'abandonAttempt'> = new CheckoutRendererService()
  ): Promise<CheckoutCompletionOutcome> {
    const issuedGeneration = contextGeneration.value
    const outcome = await service.abandonAttempt(key)
    if (contextGeneration.value !== issuedGeneration) {
      return outcome
    }

    if (outcome.outcome === 'abandoned') {
      if (blockingAttemptKey.value === key) {
        blockingAttemptKey.value = null
      }
      if (attemptKey.value === key) {
        attemptKey.value = null
        completionOutcome.value = null
      }
    }

    return outcome
  }

  /** `checkout:acknowledge-attempt` (T7/T8) — idempotent, owner-scoped. */
  async function acknowledgeAttempt(
    key: string,
    service: Pick<CheckoutRendererService, 'acknowledgeAttempt'> = new CheckoutRendererService()
  ): Promise<CheckoutCompletionOutcome> {
    const issuedGeneration = contextGeneration.value
    const outcome = await service.acknowledgeAttempt(key)
    if (contextGeneration.value !== issuedGeneration) {
      return outcome
    }

    if (outcome.outcome === 'acknowledged') {
      pendingResults.value = pendingResults.value.filter((result) => result.attemptKey !== key)
      // Acknowledging *this* draft's own result is the end of the sale: the tendered rows are now
      // history on a committed invoice, so they must not survive into the next customer's panel.
      // An unrelated recovery-banner key belongs to a different (possibly long-dead) draft and
      // must leave the cashier's current work untouched.
      if (attemptKey.value === key) {
        attemptKey.value = null
        completionOutcome.value = null
        completionErrorState.clear()
        clearDraft()
      }
    }

    return outcome
  }

  /**
   * `checkout:pending-attempts` — read-only discovery, never mutates. Called on mount and after any
   * owner-context change (login, re-login, device recovery) so the recovery banner reflects exactly
   * the current cashier's durable state, never a previous cashier's.
   */
  async function discoverPending(
    service: Pick<CheckoutRendererService, 'pendingAttempts'> = new CheckoutRendererService()
  ): Promise<void> {
    const issuedGeneration = contextGeneration.value
    try {
      const result = await service.pendingAttempts({})
      if (contextGeneration.value !== issuedGeneration) {
        return
      }

      blockingAttemptKey.value = result.blockingAttempt?.attemptKey ?? null
      pendingResults.value = result.unacknowledgedResults
    } catch (cause) {
      // Non-critical bootstrap data: a transient failure here (e.g. called before a shift
      // authority context exists) must never abort the caller's own `Promise.all` of unrelated
      // page-load work. The recovery banner simply stays empty until the next successful call.
      const publicError = parsePublicAppError(cause)
      if (publicError) {
        void handleRuntimeTransition(publicError)
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
    refreshPreview,
    attemptKey,
    completionPending,
    completionOutcome,
    completionError,
    blockingAttemptKey,
    pendingResults,
    isBlocked,
    complete,
    retryAttempt,
    abandonAttempt,
    acknowledgeAttempt,
    discoverPending
  }
})
