import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CheckoutAttemptStatus,
  CheckoutCompletionOutcome,
  CheckoutIntent,
  CheckoutPreviewOutcome,
  CheckoutRecoveryState,
  RecoveryAttemptSummary
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
  /** Rev 3: a row created by "Exact cash" for this total; dropped (never resized) if the total moves. */
  readonly exactFor?: number
}

/**
 * Failure codes after which main keeps the attempt `claimed` (a durable, protected attempt). The
 * renderer never decides this alone: after any failure it also asks `checkout:attempt-status`.
 */
const CLAIMED_FAILURE_CODES = new Set([
  'permission-denied',
  'shift-unavailable',
  'shift-not-open',
  'shift-none',
  'shift-reconciliation-required',
  'shift-observation-foreign',
  'shift-observation-unknown',
  'workstation-unassigned',
  'allocation-data-unavailable',
  'allocation-acquisition-unresolved',
  'allocation-refused',
  'allocation-integrity-blocked',
  'context-changed',
  'refresh-required'
])

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

  // --- POS reliability rev 3: identity model ----------------------------------------------------
  // `boundSaleId` is the cart draft this editable tender state belongs to. `attemptState` is main's
  // durable state for `attemptKey` as last learned. A late result is always recorded against its
  // ORIGINAL key and applied to the draft only when {generation, saleId, key} still match.
  const boundSaleId = ref<string | null>(null)
  const attemptState = ref<CheckoutAttemptStatus['state'] | null>(null)
  /** Main's recovery summary for the claimed attempt (legacy / support / outstanding requests). */
  const attemptRecovery = ref<RecoveryAttemptSummary | null>(null)
  const blockingRecovery = ref<RecoveryAttemptSummary | null>(null)
  /** An IPC call whose outcome could not be observed; main is being asked what happened. */
  const reconciling = ref(false)

  const paidTotalAmount = computed(() => rows.value.reduce((sum, row) => sum + row.amount, 0))
  const isEditingDraft = computed(() => activeMethodUuid.value !== null)
  const previewError = previewErrorState.error
  const completionError = completionErrorState.error
  const isBlocked = computed(() => blockingAttemptKey.value !== null)
  /**
   * True while this draft's attempt must not be discarded by the UI: a request in flight or being
   * reconciled, a claimed (retryable or uncertain) attempt, or a committed sale not yet
   * acknowledged. The cart is locked meanwhile.
   */
  const attemptProtected = computed(
    () =>
      completionPending.value ||
      reconciling.value ||
      completionOutcome.value?.outcome === 'committed' ||
      (attemptKey.value !== null &&
        (attemptState.value === 'claimed' || attemptState.value === 'in-flight'))
  )

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

  /**
   * Rev 3 explicit reset for a NEW draft (confirmed Clear, removing the last item, "New sale",
   * recall): editable tender rows, the half-typed amount/reference, change and preview, and the
   * completion message/error of a finished attempt. Never touches a protected attempt.
   */
  function resetEditableState(): boolean {
    if (attemptProtected.value) {
      return false
    }
    clearDraft()
    completionOutcome.value = null
    completionErrorState.clear()
    attemptKey.value = null
    attemptState.value = null
    attemptRecovery.value = null
    return true
  }

  /** Binds editable tender state to a draft; a different draft starts from a clean state. */
  function bindSale(saleId: string): void {
    if (boundSaleId.value === saleId) {
      return
    }
    if (resetEditableState() || boundSaleId.value === null) {
      boundSaleId.value = saleId
    }
  }

  /**
   * Drops "Exact cash" rows whose total no longer matches (never silently resized). Rows bound to a
   * protected attempt are what main recorded — a committed sale empties the cart — so they are never
   * touched here.
   */
  function dropStaleExactRows(outstandingTotal: number): boolean {
    if (attemptProtected.value) {
      return false
    }
    const next = rows.value.filter(
      (row) => row.exactFor === undefined || row.exactFor === outstandingTotal
    )
    if (next.length === rows.value.length) {
      return false
    }
    rows.value = next
    bumpRevision()
    return true
  }

  /** Adds one tagged cash row for exactly `amount` (the caller verified eligibility). */
  function addExactRow(methodUuid: string, amount: number): void {
    cancelDraftRow()
    rows.value = [
      ...rows.value,
      { id: crypto.randomUUID(), methodUuid, amount, reference: null, exactFor: amount }
    ]
    bumpRevision()
  }

  /** "Add remaining in cash": an ordinary (untagged) row for the outstanding amount. */
  function addRemainingRow(methodUuid: string, amount: number): void {
    cancelDraftRow()
    rows.value = [...rows.value, { id: crypto.randomUUID(), methodUuid, amount, reference: null }]
    bumpRevision()
  }

  /** Rev 3: a cart change invalidates the preview synchronously (never a stale "valid"). */
  function invalidatePreview(): void {
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
    boundSaleId.value = null
    attemptState.value = null
    attemptRecovery.value = null
    blockingRecovery.value = null
    reconciling.value = false
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
    service: Pick<CheckoutRendererService, 'complete'> &
      Partial<
        Pick<CheckoutRendererService, 'attemptStatus' | 'retryAttempt'>
      > = new CheckoutRendererService()
  ): Promise<void> {
    if (
      activeCompletionRequest !== null ||
      reconciling.value ||
      completionOutcome.value?.outcome === 'committed' ||
      completionOutcome.value?.outcome === 'acknowledged'
    ) {
      return
    }

    if (!attemptKey.value) {
      attemptKey.value = crypto.randomUUID()
    }
    const key = attemptKey.value
    const issuedGeneration = contextGeneration.value
    const issuedSaleId = boundSaleId.value
    const issuedToken = currentToken(getCartToken())
    const request = Symbol('checkout-completion')
    activeCompletionRequest = request
    completionPending.value = true
    attemptState.value = 'in-flight'
    completionErrorState.clear()

    // Rev 3: a result is applied to the draft only while {generation, sale, key} still match.
    // Otherwise it is recorded for its original key only (recovery list), never shown on — and
    // never clearing — a replacement cart. Main remains authoritative either way.
    const bound = (): boolean =>
      contextGeneration.value === issuedGeneration &&
      boundSaleId.value === issuedSaleId &&
      attemptKey.value === key

    try {
      const outcome = await service.complete(key, intent)
      if (contextGeneration.value !== issuedGeneration) {
        // Another owner is signed in now: nothing of this attempt may surface here. Main keeps it,
        // and the same cashier sees it again through `pending-attempts`.
        return
      }
      if (!bound()) {
        recordUnboundOutcome(key, outcome)
        return
      }

      applyOutcome(key, outcome, onCommitted)
      void issuedToken
    } catch (cause) {
      if (contextGeneration.value !== issuedGeneration) {
        return
      }
      const publicError = parsePublicAppError(cause)
      if (publicError) {
        void handleRuntimeTransition(publicError)
      }
      // The call's outcome was not observed. It is NEVER treated as "the sale failed": main is
      // asked what happened to this key before anything else may happen on this draft.
      if (activeCompletionRequest === request) {
        activeCompletionRequest = null
        completionPending.value = false
      }
      await reconcile(
        key,
        onCommitted,
        {
          attemptStatus: (k) =>
            service.attemptStatus
              ? service.attemptStatus(k)
              : new CheckoutRendererService().attemptStatus(k),
          retryAttempt: (k) =>
            service.retryAttempt
              ? service.retryAttempt(k)
              : new CheckoutRendererService().retryAttempt(k)
        },
        bound
      )
      if (
        contextGeneration.value === issuedGeneration &&
        boundSaleId.value === issuedSaleId &&
        attemptState.value === null &&
        completionOutcome.value === null
      ) {
        // Main holds nothing durable for this key: the request never took effect. Say so.
        if (publicError) {
          completionErrorState.setDetail(publicError)
        } else {
          completionErrorState.setFallbackKey('pos.payment.completion.unavailable')
        }
      }
    } finally {
      // The committed callback intentionally clears the cart. Busy state belongs to this request,
      // not to the draft: only a reset/newer request may take ownership away.
      if (activeCompletionRequest === request) {
        activeCompletionRequest = null
        completionPending.value = false
      }
    }
  }

  function recordUnboundOutcome(key: string, outcome: CheckoutCompletionOutcome): void {
    if (
      outcome.outcome === 'committed' &&
      !pendingResults.value.some((r) => r.attemptKey === key)
    ) {
      pendingResults.value = [
        ...pendingResults.value,
        { attemptKey: key, committedAt: outcome.invoice.soldAt }
      ]
    }
    if (outcome.outcome === 'failed' && CLAIMED_FAILURE_CODES.has(outcome.code)) {
      blockingAttemptKey.value = key
    }
  }

  function applyOutcome(
    key: string,
    outcome: CheckoutCompletionOutcome,
    onCommitted: () => void
  ): void {
    completionOutcome.value = outcome
    completionErrorState.clear()

    if (outcome.outcome === 'committed') {
      attemptState.value = 'committed'
      attemptRecovery.value = null
      onCommitted()
    } else if (outcome.outcome === 'rejected') {
      // T3: this exact key can never become a sale again. A corrected cart needs a new key.
      attemptKey.value = null
      attemptState.value = null
      attemptRecovery.value = null
    } else if (outcome.outcome === 'failed') {
      if (outcome.code === 'attempt-blocked') {
        blockingAttemptKey.value = outcome.blockingAttemptKey ?? null
        attemptKey.value = null
        attemptState.value = null
      } else if (CLAIMED_FAILURE_CODES.has(outcome.code) || outcome.code === 'policy-blocked') {
        attemptState.value = 'claimed'
        void refreshAttemptStatus(key)
      } else {
        // Not claimed by main (e.g. attempt-conflict, invalid-request): the key is released.
        attemptKey.value = outcome.code === 'attempt-conflict' ? null : attemptKey.value
        attemptState.value = null
      }
    }
  }

  async function refreshAttemptStatus(
    key: string,
    service?: Pick<CheckoutRendererService, 'attemptStatus'>
  ): Promise<void> {
    const issuedGeneration = contextGeneration.value
    try {
      const status = await (service ?? new CheckoutRendererService()).attemptStatus(key)
      if (contextGeneration.value !== issuedGeneration || attemptKey.value !== key) {
        return
      }
      if (status.state === 'claimed' || status.state === 'in-flight') {
        attemptState.value = status.state
        attemptRecovery.value = status.recovery ?? attemptRecovery.value
      } else if (status.state === 'unknown') {
        // No row for this owner: main never claimed it, so nothing durable is protected.
        attemptKey.value = null
        attemptState.value = null
        attemptRecovery.value = null
      }
    } catch {
      // Keep the protected state; a later action re-asks.
    }
  }

  /**
   * After an IPC failure: ask main for this key's durable state until it is decided. Committed
   * results are re-read through `retry` (a read-only replay for a non-claimed row).
   */
  async function reconcile(
    key: string,
    onCommitted: () => void,
    service: Pick<CheckoutRendererService, 'attemptStatus' | 'retryAttempt'>,
    bound: () => boolean
  ): Promise<void> {
    const issuedGeneration = contextGeneration.value
    reconciling.value = true
    try {
      for (let round = 0; round < 20; round += 1) {
        let status: CheckoutAttemptStatus
        try {
          status = await service.attemptStatus(key)
        } catch {
          await sleep(500)
          continue
        }
        if (contextGeneration.value !== issuedGeneration) {
          return
        }
        if (status.state === 'in-flight') {
          await sleep(500)
          continue
        }
        if (status.state === 'committed' || status.state === 'acknowledged') {
          const replay = await service.retryAttempt(key)
          if (contextGeneration.value !== issuedGeneration) {
            return
          }
          if (bound()) {
            applyOutcome(key, replay, onCommitted)
          } else {
            recordUnboundOutcome(key, replay)
          }
          return
        }
        if (status.state === 'claimed') {
          if (bound()) {
            attemptState.value = 'claimed'
            attemptRecovery.value = status.recovery ?? null
          } else {
            blockingAttemptKey.value = key
          }
          return
        }
        if (bound()) {
          // rejected / abandoned / unknown (never reached main): the key holds nothing durable.
          attemptKey.value = null
          attemptState.value = null
          attemptRecovery.value = null
        }
        return
      }
      // Still undecided: stay protected; the recovery banner offers an explicit re-check.
      if (bound()) {
        attemptState.value = 'claimed'
      }
    } finally {
      if (contextGeneration.value === issuedGeneration) {
        reconciling.value = false
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
  ): Promise<CheckoutCompletionOutcome | null> {
    const issuedGeneration = contextGeneration.value
    let outcome: CheckoutCompletionOutcome
    try {
      completionPending.value = true
      outcome = await service.retryAttempt(key)
    } catch (cause) {
      if (contextGeneration.value === issuedGeneration) {
        reportActionError(cause)
      }
      return null
    } finally {
      if (contextGeneration.value === issuedGeneration) {
        completionPending.value = false
      }
    }
    // A logout/device-recovery/cashier change while this call was in flight must never let its
    // result apply to whoever the current owner is now (plan §2.10: late responses never apply to
    // a newer session).
    if (contextGeneration.value !== issuedGeneration) {
      return outcome
    }

    if (key === attemptKey.value) {
      // This draft's own attempt: apply exactly like a completion result (no cart clear needed —
      // the cart is locked to this attempt and cleared on acknowledge).
      applyOutcome(key, outcome, () => undefined)
    } else if (outcome.outcome === 'committed') {
      // A different (recovery-banner) attempt: recorded against its own key only — it never
      // replaces this draft's completion state or tender rows.
      recordUnboundOutcome(key, outcome)
    }

    if (outcome.outcome !== 'failed' && blockingAttemptKey.value === key) {
      blockingAttemptKey.value = null
      blockingRecovery.value = null
    }

    return outcome
  }

  function reportActionError(cause: unknown): void {
    const publicError = parsePublicAppError(cause)
    if (publicError) {
      void handleRuntimeTransition(publicError)
      completionErrorState.setDetail(publicError)
    } else {
      completionErrorState.setFallbackKey('pos.payment.completion.unavailable')
    }
  }

  /** `checkout:abandon-attempt` (T5, D1-A) — no `pos.sell`/open-shift/commercial-access required. */
  async function abandonAttempt(
    key: string,
    optionsOrService:
      | { readonly acknowledgeLegacyUncertainty?: boolean }
      | Pick<CheckoutRendererService, 'abandonAttempt'> = {},
    serviceArgument?: Pick<CheckoutRendererService, 'abandonAttempt'>
  ): Promise<CheckoutCompletionOutcome | null> {
    const isService = 'abandonAttempt' in optionsOrService
    const options = isService ? {} : optionsOrService
    const service: Pick<CheckoutRendererService, 'abandonAttempt'> = isService
      ? (optionsOrService as Pick<CheckoutRendererService, 'abandonAttempt'>)
      : (serviceArgument ?? new CheckoutRendererService())
    const issuedGeneration = contextGeneration.value
    let outcome: CheckoutCompletionOutcome
    try {
      outcome = await service.abandonAttempt(key, options)
    } catch (cause) {
      if (contextGeneration.value === issuedGeneration) {
        reportActionError(cause)
      }
      return null
    }
    if (contextGeneration.value !== issuedGeneration) {
      return outcome
    }

    if (outcome.outcome === 'abandoned') {
      if (blockingAttemptKey.value === key) {
        blockingAttemptKey.value = null
        blockingRecovery.value = null
      }
      if (attemptKey.value === key) {
        attemptKey.value = null
        attemptState.value = null
        attemptRecovery.value = null
        completionOutcome.value = null
        completionErrorState.clear()
      }
    } else if (key === attemptKey.value) {
      completionOutcome.value = outcome
    }

    return outcome
  }

  /** `checkout:acknowledge-attempt` (T7/T8) — idempotent, owner-scoped. */
  async function acknowledgeAttempt(
    key: string,
    service: Pick<CheckoutRendererService, 'acknowledgeAttempt'> = new CheckoutRendererService()
  ): Promise<CheckoutCompletionOutcome | null> {
    const issuedGeneration = contextGeneration.value
    let outcome: CheckoutCompletionOutcome
    try {
      outcome = await service.acknowledgeAttempt(key)
    } catch (cause) {
      if (contextGeneration.value === issuedGeneration) {
        reportActionError(cause)
      }
      return null
    }
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
        attemptState.value = null
        attemptRecovery.value = null
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
      blockingRecovery.value = result.blockingAttempt?.recovery ?? null
      if (result.blockingAttempt && result.blockingAttempt.attemptKey === attemptKey.value) {
        attemptState.value = 'claimed'
        attemptRecovery.value = result.blockingAttempt.recovery ?? null
      }
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
    clearDraft,
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
    discoverPending,
    boundSaleId,
    attemptState,
    attemptRecovery,
    blockingRecovery,
    reconciling,
    attemptProtected,
    bindSale,
    resetEditableState,
    invalidatePreview,
    addExactRow,
    addRemainingRow,
    dropStaleExactRows,
    refreshAttemptStatus
  }
})
