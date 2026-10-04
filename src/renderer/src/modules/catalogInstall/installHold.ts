import { computed, ref, watch, type Ref } from 'vue'
import type { Pinia } from 'pinia'
import type {
  DraftState,
  InstallHoldRequest,
  InstallRelease
} from '@shared/contracts/catalogInstall.contract'
import { useCartStore } from '../pos/cart.store'
import { usePaymentStore } from '../pos/payment.store'
import { useCatalogStore } from '../pos/catalog.store'

/**
 * Rev 4 §8.2 — the renderer side of the catalog-install hold.
 *
 * - The POS draft (cart lines, held drafts, payment state) is reported to main on every change,
 *   with a monotonically increasing generation, so main can tell whether an install would
 *   supersede something and whether the draft changed between the handshake and the write.
 * - On `catalog:install-hold` the hold is armed SYNCHRONOUSLY (before replying) when admitted for
 *   the path. While armed, adds, scans, recalls and checkout claims wait (`waitForInstallHold`).
 * - Only main's terminal state releases the hold: the `catalog:install-release` push, or — when
 *   that push is lost — the status poll that starts at 3 s and repeats every second.
 * - On `installed`, the new contract is read and applied to the cart BEFORE the hold resolves, so
 *   queued actions run against the new revision, never the superseded one.
 */

interface ActiveHold {
  readonly id: string
  readonly promise: Promise<void>
  readonly resolve: () => void
  settled: boolean
  pollTimer: ReturnType<typeof setTimeout> | null
}

const holdActive = ref(false)
let active: ActiveHold | null = null
let draftGeneration = 0
let started = false

export const installHoldActive: Readonly<Ref<boolean>> = holdActive

/** Resolves immediately when no install hold is armed; otherwise when main releases it. */
export function waitForInstallHold(): Promise<void> {
  return active && !active.settled ? active.promise : Promise.resolve()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function startCatalogInstallClient(pinia: Pinia): void {
  if (started || typeof window === 'undefined' || !window.posApi?.catalogInstall) {
    return
  }
  started = true

  const cart = useCartStore(pinia)
  const payment = usePaymentStore(pinia)
  const catalog = useCatalogStore(pinia)
  const api = window.posApi.catalogInstall

  const signature = computed(() =>
    JSON.stringify({
      lines: cart.lines.map((line) => [line.id, String(line.quantity)]),
      held: cart.heldDrafts.map((draft) => draft.id),
      rows: payment.rows.length,
      attempt: payment.attemptKey,
      blocking: payment.blockingAttemptKey,
      pending: payment.completionPending,
      panel: payment.panelOpen
    })
  )

  const draft = (): DraftState => ({
    generation: draftGeneration,
    hasLines: cart.lines.length > 0,
    hasHeldDrafts: cart.heldDrafts.length > 0,
    paymentActive:
      payment.panelOpen || payment.attemptKey !== null || payment.blockingAttemptKey !== null,
    completionPending: payment.completionPending
  })

  const report = (): void => {
    void api.reportDraftState(draft()).catch(() => undefined)
  }

  watch(
    signature,
    () => {
      draftGeneration += 1
      report()
    },
    { immediate: true }
  )

  const applyInstalledContract = async (): Promise<void> => {
    let delay = 500
    for (;;) {
      try {
        await catalog.initialize()
        const contract = catalog.status?.catalogValid ? catalog.status.contract : null
        if (contract) {
          cart.setContract(contract)
        }
        catalog.recordInstall?.()
        return
      } catch {
        // Keep holding: queued actions must never run against an unread contract.
        await sleep(delay)
        delay = Math.min(delay * 2, 5000)
      }
    }
  }

  const finish = async (holdId: string, installed: boolean): Promise<void> => {
    const hold = active
    if (!hold || hold.id !== holdId || hold.settled) {
      return
    }
    hold.settled = true
    if (hold.pollTimer) {
      clearTimeout(hold.pollTimer)
    }
    if (installed) {
      await applyInstalledContract()
    } else {
      await catalog.initialize().catch(() => undefined)
    }
    if (active === hold) {
      active = null
    }
    holdActive.value = false
    hold.resolve()
  }

  const poll = (holdId: string, delayMs: number): void => {
    const hold = active
    if (!hold || hold.id !== holdId || hold.settled) {
      return
    }
    hold.pollTimer = setTimeout(async () => {
      try {
        const result = await api.holdStatus({ holdId })
        const state = result.ok ? result.data.state : 'unknown'
        if (state === 'installed') {
          await finish(holdId, true)
          return
        }
        if (state === 'aborted' || state === 'unknown') {
          await finish(holdId, false)
          return
        }
      } catch {
        // Keep polling; main owns the outcome.
      }
      poll(holdId, 1000)
    }, delayMs)
  }

  api.onHold((request: InstallHoldRequest) => {
    const current = draft()
    const idle =
      !current.hasLines &&
      !current.hasHeldDrafts &&
      !current.paymentActive &&
      !current.completionPending
    const admitted =
      request.path === 'stale' ||
      (request.path === 'background' && idle) ||
      (request.path === 'manual' &&
        !current.paymentActive &&
        !current.completionPending &&
        ((!current.hasLines && !current.hasHeldDrafts) ||
          current.generation === request.consentGeneration))

    if (admitted) {
      // Armed synchronously, before the reply leaves this tick.
      let resolve: () => void = () => undefined
      const promise = new Promise<void>((r) => (resolve = r))
      active = { id: request.holdId, promise, resolve, settled: false, pollTimer: null }
      holdActive.value = true
      poll(request.holdId, 3000)
    }

    void api
      .replyHold({ holdId: request.holdId, admitted, generation: current.generation })
      .catch(() => undefined)
  })

  api.onRelease((release: InstallRelease) => {
    void finish(release.holdId, release.installed)
  })

  // Rev 4 §9.1: main settled a claimed attempt (or a legacy one needs attention) without being
  // asked — re-discover so the POS shows the durable state without any navigation.
  window.posApi.checkout?.onAttemptsChanged?.(() => {
    void payment.discoverPending()
  })
}

/** The current draft snapshot, for the manual-refresh consent (bound to its generation). */
export function currentDraftGeneration(): number {
  return draftGeneration
}
