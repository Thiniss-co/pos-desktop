import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CloseShiftInput,
  OpenShiftInput,
  PauseShiftInput,
  ResumeShiftInput,
  Shift
} from '@shared/contracts/shift.contract'
import type { PublicAppError } from '@shared/contracts/api.contract'
import type { ShiftLocalAuthority } from '@shared/contracts/shiftAuthority.contract'
import { handleRuntimeTransition } from '@renderer/app/session/runtimeTransition'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { ShiftRendererService } from './shift.service'

export type ShiftFreshness = 'loading' | 'current' | 'cached' | 'unknown' | 'error'
export type ShiftMutation = 'opening' | 'pausing' | 'resuming' | 'closing' | null

const stateConflictCodes = new Set([
  'DESKTOP_SHIFT_ALREADY_OPEN',
  'DESKTOP_SHIFT_NOT_OPEN',
  'DESKTOP_SHIFT_ALREADY_PAUSED',
  'DESKTOP_SHIFT_NOT_PAUSED',
  'DESKTOP_SHIFT_ACTIVE_PAUSE_NOT_FOUND'
])

export const useShiftStore = defineStore('shift', () => {
  const currentShift = ref<Shift | null>(null)
  /**
   * The main process's durable, owner-scoped observation, read only when an authoritative refresh
   * fails on transport. It is never derived in the renderer and never survives a non-transport
   * outcome, so a stale renderer value can not by itself admit a sale.
   */
  const localAuthority = ref<ShiftLocalAuthority | null>(null)
  const freshness = ref<ShiftFreshness>('loading')
  const mutation = ref<ShiftMutation>(null)
  const errorState = createLocalizedErrorRef()
  const error = errorState.error
  let latestLoad = 0

  /**
   * `current` is the authoritative server answer. `cached` is admitted only by the main process's
   * own sell verdict — every other authority kind (none / not-open / reconciliation-required /
   * unknown / foreign) is a denial, exactly as `checkout:complete` treats it.
   */
  const canSell = computed(() => {
    if (freshness.value === 'current') {
      return currentShift.value?.status === 'open'
    }

    return freshness.value === 'cached' && localAuthority.value?.kind === 'open'
  })

  /**
   * The shift the page is bound to, from the server DTO when one is held and otherwise from local
   * authority. Deliberately independent of `freshness` so it does not blink to null during an
   * in-flight refresh — a blink would look like a shift change and discard the cashier's draft.
   * It grants nothing on its own: `canSell` is the only sell gate.
   */
  const activeShiftUuid = computed(
    () =>
      currentShift.value?.uuid ??
      (localAuthority.value?.kind === 'open' ? localAuthority.value.shiftUuid : null)
  )

  /** The status to display when no server DTO is held but local authority still names an open shift. */
  const observedStatus = computed<Shift['status'] | null>(
    () => currentShift.value?.status ?? (localAuthority.value?.kind === 'open' ? 'open' : null)
  )

  function setError(cause: unknown): PublicAppError | null {
    const publicError = parsePublicAppError(cause)

    if (publicError) {
      void handleRuntimeTransition(publicError)
      errorState.setDetail(publicError)
      return publicError
    }

    errorState.setFallbackKey('pos.shiftUnavailable')
    return null
  }

  async function loadCurrent(service = new ShiftRendererService()): Promise<boolean> {
    const request = ++latestLoad
    freshness.value = 'loading'

    try {
      const shift = await service.current()

      if (request !== latestLoad) {
        return false
      }

      currentShift.value = shift
      localAuthority.value = null
      freshness.value = 'current'
      errorState.clear()
      return true
    } catch (cause) {
      if (request === latestLoad) {
        const publicError = setError(cause)
        // A transport failure (including HTTP 5xx, and a refused connection with no HTTP status at
        // all) says only that the current state could not be refreshed — never that the shift is
        // gone. Renderer memory is not evidence either: it is empty after every app restart, which
        // is exactly when the backend is most likely still unreachable. So ask the main process for
        // its durable, owner-scoped observation and let that verdict decide.
        const authority =
          publicError?.category === 'transport' ? await readLocalAuthority(service) : null

        // A newer load may have resolved while the authority read was in flight; that answer wins.
        if (request === latestLoad) {
          localAuthority.value = authority
          freshness.value = authority?.kind === 'open' ? 'cached' : 'error'
        }
      }
      return false
    }
  }

  /**
   * Never throws: a denied or unavailable authority read must land on the same denial as no
   * authority at all, not on a second error path that could be mistaken for a transport failure.
   */
  async function readLocalAuthority(
    service: ShiftRendererService
  ): Promise<ShiftLocalAuthority | null> {
    try {
      return await service.localAuthority()
    } catch {
      return null
    }
  }

  async function reconcileAfterAmbiguousFailure(service: ShiftRendererService): Promise<void> {
    freshness.value = 'unknown'
    const reconciled = await loadCurrent(service)

    if (!reconciled) {
      freshness.value = 'unknown'
    }
  }

  async function refreshAfterStateConflict(service: ShiftRendererService): Promise<void> {
    const request = ++latestLoad

    try {
      const shift = await service.current()

      if (request === latestLoad) {
        currentShift.value = shift
        localAuthority.value = null
        freshness.value = 'current'
      }
    } catch {
      if (request === latestLoad) {
        freshness.value = 'unknown'
      }
    }
  }

  async function mutate(
    kind: Exclude<ShiftMutation, null>,
    operation: (service: ShiftRendererService) => Promise<Shift>,
    service = new ShiftRendererService()
  ): Promise<boolean> {
    if (mutation.value) {
      return false
    }

    if (freshness.value !== 'current') {
      if (!(await loadCurrent(service))) {
        return false
      }
    }

    latestLoad += 1
    mutation.value = kind
    errorState.clear()

    try {
      currentShift.value = await operation(service)
      localAuthority.value = null
      freshness.value = 'current'
      return true
    } catch (cause) {
      const publicError = setError(cause)

      if (!publicError || publicError.category === 'transport') {
        await reconcileAfterAmbiguousFailure(service)
      } else if (publicError.backendCode && stateConflictCodes.has(publicError.backendCode)) {
        await refreshAfterStateConflict(service)
      }

      return false
    } finally {
      mutation.value = null
    }
  }

  function open(input: OpenShiftInput, service = new ShiftRendererService()): Promise<boolean> {
    return mutate('opening', (gateway) => gateway.open(input), service)
  }

  function pause(input: PauseShiftInput, service = new ShiftRendererService()): Promise<boolean> {
    return mutate('pausing', (gateway) => gateway.pause(input), service)
  }

  function resume(input: ResumeShiftInput, service = new ShiftRendererService()): Promise<boolean> {
    return mutate('resuming', (gateway) => gateway.resume(input), service)
  }

  function close(input: CloseShiftInput, service = new ShiftRendererService()): Promise<boolean> {
    return mutate('closing', (gateway) => gateway.close(input), service)
  }

  return {
    currentShift,
    localAuthority,
    activeShiftUuid,
    observedStatus,
    freshness,
    mutation,
    error,
    canSell,
    loadCurrent,
    open,
    pause,
    resume,
    close
  }
})
