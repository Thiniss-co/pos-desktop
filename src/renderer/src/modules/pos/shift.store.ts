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
import { handleRuntimeTransition } from '@renderer/app/session/runtimeTransition'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { ShiftRendererService } from './shift.service'

export type ShiftFreshness = 'loading' | 'current' | 'unknown' | 'error'
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
  const freshness = ref<ShiftFreshness>('loading')
  const mutation = ref<ShiftMutation>(null)
  const errorState = createLocalizedErrorRef()
  const error = errorState.error
  let latestLoad = 0

  const canSell = computed(
    () => freshness.value === 'current' && currentShift.value?.status === 'open'
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
      freshness.value = 'current'
      errorState.clear()
      return true
    } catch (cause) {
      if (request === latestLoad) {
        freshness.value = 'error'
        setError(cause)
      }
      return false
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
    if (mutation.value || freshness.value === 'unknown' || freshness.value === 'error') {
      if (freshness.value === 'unknown' || freshness.value === 'error') {
        await loadCurrent(service)
      }

      if (mutation.value || freshness.value !== 'current') {
        return false
      }
    }

    if (freshness.value !== 'current') {
      return false
    }

    latestLoad += 1
    mutation.value = kind
    errorState.clear()

    try {
      currentShift.value = await operation(service)
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
