import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { useAccessStore } from '@renderer/modules/access/store'
import { StartupService } from './startup.service'
import type { StartupError, StartupSnapshot, StartupState } from './types'

function isPublicAppError(value: unknown): value is PublicAppError {
  return typeof value === 'object' && value !== null && 'message' in value && 'category' in value
}

function determineStartupState(snapshot: StartupSnapshot): StartupState {
  if (!snapshot.device.isRegistered) {
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
      const detail = isPublicAppError(cause) ? cause : undefined
      state.value = detail?.category === 'authorization' ? 'access_blocked' : 'fatal_error'
      error.value = {
        message: detail?.message ?? 'The application could not be initialized',
        detail
      }

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
