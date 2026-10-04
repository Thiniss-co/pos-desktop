import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { WorkstationRefreshOutcome } from '@shared/contracts/catalogInstall.contract'
import { useCartStore } from '../pos/cart.store'
import { usePaymentStore } from '../pos/payment.store'
import { useCatalogStore } from '../pos/catalog.store'
import { currentDraftGeneration, installHoldActive } from './installHold'

export type WorkstationRefreshMessage =
  'installed' | 'payment-active' | 'draft-changed' | 'busy' | 'denied' | 'failed' | 'license-only'

/**
 * Rev 4 §13 / §8.3 manual path — the header "Refresh workstation".
 *
 * Consent comes FIRST and outside any machine timeout: with a populated cart (or parked sales) the
 * cashier is asked, and the consent is bound to the draft generation at the moment they confirm.
 * Main then installs only if the draft is still at that generation (or empty) when the hold is
 * armed and again inside the persist transaction; otherwise "Your sale changed — refresh again".
 */
export const useWorkstationRefreshStore = defineStore('workstationRefresh', () => {
  const status = ref<'idle' | 'confirming' | 'pending'>('idle')
  const lastMessage = ref<WorkstationRefreshMessage | null>(null)
  const lastOutcomeAt = ref<string | null>(null)

  const cart = useCartStore()
  const payment = usePaymentStore()
  const catalog = useCatalogStore()

  const busy = computed(() => status.value === 'pending' || installHoldActive.value)
  const lastRefreshedAt = computed(() => catalog.lastRefreshedAt)

  function paymentInProgress(): boolean {
    return (
      payment.panelOpen ||
      payment.completionPending ||
      payment.attemptKey !== null ||
      payment.blockingAttemptKey !== null
    )
  }

  function draftHasWork(): boolean {
    return cart.lines.length > 0 || cart.heldDrafts.length > 0
  }

  async function run(consentGeneration: number): Promise<void> {
    status.value = 'pending'
    lastMessage.value = null
    try {
      const result = await window.posApi.catalogInstall.refreshWorkstation({
        consent: { generation: consentGeneration }
      })
      const outcome: WorkstationRefreshOutcome = result.ok ? result.data.outcome : 'failed'
      if (result.ok && outcome === 'installed') {
        catalog.recordInstall(result.data.revisionChanged)
      }
      lastMessage.value = outcome
    } catch {
      lastMessage.value = 'failed'
    } finally {
      status.value = 'idle'
      lastOutcomeAt.value = new Date().toISOString()
    }
  }

  /** The header button. */
  async function request(): Promise<void> {
    if (busy.value || status.value === 'confirming') {
      return
    }
    if (paymentInProgress()) {
      lastMessage.value = 'payment-active'
      lastOutcomeAt.value = new Date().toISOString()
      return
    }
    if (draftHasWork()) {
      status.value = 'confirming'
      return
    }
    await run(currentDraftGeneration())
  }

  /** The consent dialog's confirm: bound to the draft generation at THIS moment. */
  async function confirm(): Promise<void> {
    if (status.value !== 'confirming') {
      return
    }
    await run(currentDraftGeneration())
  }

  function cancel(): void {
    if (status.value === 'confirming') {
      status.value = 'idle'
    }
  }

  function dismissMessage(): void {
    lastMessage.value = null
  }

  return {
    status,
    busy,
    lastMessage,
    lastOutcomeAt,
    lastRefreshedAt,
    request,
    confirm,
    cancel,
    dismissMessage
  }
})
