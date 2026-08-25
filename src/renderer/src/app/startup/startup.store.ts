import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useAccessStore } from '@renderer/modules/access/store'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { isTerminalDeviceStatus } from '@shared/constants/deviceStatuses'
import { StartupService } from './startup.service'
import type { StartupError, StartupSnapshot, StartupState } from './types'

function determineStartupState(snapshot: StartupSnapshot): StartupState {
  if (
    !snapshot.device.isRegistered ||
    (snapshot.device.registrationStatus !== null &&
      isTerminalDeviceStatus(snapshot.device.registrationStatus))
  ) {
    return 'needs_activation'
  }

  if (!snapshot.session.isAuthenticated) {
    return 'needs_login'
  }

  if (!snapshot.bootstrap.isComplete) {
    return 'needs_bootstrap'
  }

  return 'ready'
}

export const useStartupStore = defineStore('startup', () => {
  const state = ref<StartupState>('starting')
  const snapshot = ref<StartupSnapshot | null>(null)
  const error = ref<StartupError | null>(null)
  const isInitialized = ref(false)
  let initialization: Promise<void> | null = null

  const isReady = computed(() => state.value === 'ready')

  async function evaluate(service: StartupService): Promise<void> {
    state.value = 'starting'
    error.value = null

    try {
      const nextSnapshot = await service.getSnapshot()
      snapshot.value = nextSnapshot
      state.value = determineStartupState(nextSnapshot)
    } catch (cause) {
      const detail = parsePublicAppError(cause) ?? undefined
      state.value = detail?.category === 'authorization' ? 'access_blocked' : 'fatal_error'
      // `message` is only a diagnostic fallback for the (rare) case where `detail` itself is
      // absent — e.g. a thrown value that isn't a recognizable PublicAppError. It is intentionally
      // left unset rather than baked from an English literal here: FatalErrorPage.vue resolves the
      // displayed text with the reactive `startup.fatalFallback` catalog key in that case, so it
      // stays translated and reacts to a later language switch.
      error.value = { message: detail?.message, detail }

      if (state.value === 'access_blocked') {
        useAccessStore().setFromError(detail)
      }
    } finally {
      isInitialized.value = true
    }
  }

  async function initialize(service = new StartupService()): Promise<void> {
    if (initialization) {
      return initialization
    }

    initialization = evaluate(service)
    return initialization
  }

  async function refresh(service = new StartupService()): Promise<void> {
    initialization = evaluate(service)
    return initialization
  }

  return {
    state,
    snapshot,
    error,
    isInitialized,
    isReady,
    initialize,
    refresh
  }
})

export { determineStartupState }
