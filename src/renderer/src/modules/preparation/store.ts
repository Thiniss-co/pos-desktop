import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type {
  PreparationCycleResult,
  PreparationReadiness
} from '@shared/contracts/preparation.contract'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { PreparationService } from './service'

/**
 * CP4 — offline stock preparation readiness (plan §8.5, §8.6).
 *
 * ## The countdown is never computed here
 *
 * `remainingSeconds` arrives from main, derived from **trusted** time against the decision's
 * immutable `authority_ready_until`. This store re-reads it; it never re-derives it from the wall
 * clock, and it never restarts it when the screen opens. §8.5 is explicit that re-deriving the
 * countdown from the moment the screen opened is forbidden, and §13 lists it as a stop condition —
 * a renderer clock is exactly how that would happen by accident.
 *
 * The refresh interval only decides how often the *displayed* number is re-read from main. It has
 * no effect on the number itself.
 */
export const usePreparationStore = defineStore('preparation', () => {
  const readiness = ref<PreparationReadiness | null>(null)
  const isRunning = ref(false)
  const isLoading = ref(false)
  const lastCycle = ref<PreparationCycleResult | null>(null)
  const errorState = createLocalizedErrorRef()
  const error = errorState.error

  const service = new PreparationService()

  /**
   * A backend error is localized through its stable `backendCode`; anything else falls back to a
   * catalog key. A raw thrown message is never shown: it is not localized, and it can carry
   * internal detail the operator has no use for.
   */
  function captureError(caught: unknown, fallbackKey: string): void {
    const parsed = publicAppErrorSchema.safeParse(caught)

    if (parsed.success) {
      errorState.setDetail(parsed.data)

      return
    }

    errorState.setFallbackKey(fallbackKey)
  }
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  // Guards against interleaved reads resolving out of order and showing an older projection.
  let sequence = 0

  const isAvailable = computed(() => readiness.value?.available === true)
  const timeState = computed(() => readiness.value?.time.state ?? 'not_prepared')
  const quantityState = computed(() => readiness.value?.quantity.state ?? 'zero')
  const remainingSeconds = computed(() => readiness.value?.time.remainingSeconds ?? 0)

  /**
   * §8.6: the exact phrase "Ready for 72 hours" is permitted **only** while the whole requested
   * window still remains — that is, only at the moment of a successful preparation. From the next
   * second onward the honest statement is a countdown, which is a different message key.
   *
   * Main already distinguishes these as two separate states, so this is a read rather than a
   * judgement call the renderer could get wrong.
   */
  const showsFullWindowClaim = computed(() => timeState.value === 'ready_full_window')

  const hasUnresolvedOperations = computed(
    () => (readiness.value?.unresolvedOperations.length ?? 0) > 0
  )

  async function refresh(): Promise<void> {
    const token = (sequence += 1)
    isLoading.value = true

    try {
      const next = await service.getReadiness()

      if (token === sequence) {
        readiness.value = next
        errorState.clear()
      }
    } catch (caught) {
      if (token === sequence) {
        captureError(caught, 'preparation.readinessUnavailable')
      }
    } finally {
      if (token === sequence) {
        isLoading.value = false
      }
    }
  }

  /**
   * Ask main to run a cycle.
   *
   * "Ask" is the whole of it: main decides which products are eligible, whether an unresolved
   * operation must be replayed first, and whether anything is dispatched at all. Repeated clicks
   * cannot create a second operation for a product an unresolved one already owns (§5.6, §6.8).
   */
  async function runCycle(): Promise<void> {
    if (isRunning.value) {
      return
    }

    isRunning.value = true

    try {
      lastCycle.value = await service.runCycle()
      errorState.clear()
    } catch (caught) {
      captureError(caught, 'preparation.cycleUnavailable')
    } finally {
      isRunning.value = false
      await refresh()
    }
  }

  function start(intervalMs = 30_000): void {
    stop()
    void refresh()
    refreshTimer = setInterval(() => {
      void refresh()
    }, intervalMs)
  }

  function stop(): void {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  function reset(): void {
    stop()
    sequence += 1
    readiness.value = null
    lastCycle.value = null
    isRunning.value = false
    isLoading.value = false
    errorState.clear()
  }

  return {
    readiness,
    isAvailable,
    isLoading,
    isRunning,
    lastCycle,
    error,
    timeState,
    quantityState,
    remainingSeconds,
    showsFullWindowClaim,
    hasUnresolvedOperations,
    refresh,
    runCycle,
    start,
    stop,
    reset
  }
})
