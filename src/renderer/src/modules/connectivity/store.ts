import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import { ConnectivityGatewayService } from './service'

const CHECKING_HINT_DELAY_MS = 2_000
const RESTORED_TOAST_DURATION_MS = 4_000

export const useConnectivityStore = defineStore('connectivity', () => {
  const snapshot = ref<ConnectivitySnapshot | null>(null)
  const isRetrying = ref(false)
  const isCheckingHintVisible = ref(false)
  const isRestoredToastVisible = ref(false)
  const showOfflineWarning = computed(() => snapshot.value?.status === 'offline')
  const showBackendUnavailableWarning = computed(
    () => snapshot.value?.status === 'backend_unreachable'
  )
  const showCheckingHint = computed(
    () => snapshot.value?.status === 'checking' && isCheckingHintVisible.value
  )
  const showRestoredToast = computed(() => isRestoredToastVisible.value)
  const restoredListeners = new Set<() => void>()
  let unsubscribe: (() => void) | null = null
  let removeOnlineListener: (() => void) | null = null
  let checkingTimer: ReturnType<typeof setTimeout> | null = null
  let restoredTimer: ReturnType<typeof setTimeout> | null = null
  let initialization: Promise<void> | null = null
  // The service only pushes a snapshot through `checking` while transitioning out of a settled
  // state (see connectivity.service.ts), so comparing against the raw previous status would make
  // both the restored toast and the backend-restored hook unreachable. Track the last status that
  // was not `checking` instead.
  let lastSettledStatus: ConnectivitySnapshot['status'] | undefined
  // Incremented on every applied snapshot, whether pushed or fetched. A `getState()`/`checkNow()`
  // reply is only applied if no push landed while it was in flight — otherwise an in-flight fetch
  // that resolves after a later broadcast would silently overwrite the newer state.
  let sequence = 0

  function clearCheckingTimer(): void {
    if (checkingTimer) {
      clearTimeout(checkingTimer)
      checkingTimer = null
    }
  }

  function clearRestoredTimer(): void {
    if (restoredTimer) {
      clearTimeout(restoredTimer)
      restoredTimer = null
    }
  }

  function receive(nextSnapshot: ConnectivitySnapshot): void {
    sequence += 1

    const previousSettledStatus = lastSettledStatus
    snapshot.value = nextSnapshot
    clearCheckingTimer()

    if (nextSnapshot.status === 'checking') {
      isCheckingHintVisible.value = false
      checkingTimer = setTimeout(() => {
        if (snapshot.value?.status === 'checking') {
          isCheckingHintVisible.value = true
        }
      }, CHECKING_HINT_DELAY_MS)
    } else {
      isCheckingHintVisible.value = false
    }

    if (previousSettledStatus === 'offline' && nextSnapshot.status === 'online') {
      clearRestoredTimer()
      isRestoredToastVisible.value = true
      restoredTimer = setTimeout(() => {
        isRestoredToastVisible.value = false
      }, RESTORED_TOAST_DURATION_MS)
    }

    if (
      previousSettledStatus !== undefined &&
      previousSettledStatus !== 'online' &&
      nextSnapshot.status === 'online'
    ) {
      for (const listener of restoredListeners) {
        listener()
      }
    }

    if (nextSnapshot.status !== 'checking') {
      lastSettledStatus = nextSnapshot.status
    }
  }

  /** Applies `promise`'s result only if no push has been received since it started. */
  async function applyIfFresh(promise: Promise<ConnectivitySnapshot>): Promise<void> {
    const requestedAt = sequence
    const result = await promise

    if (sequence === requestedAt) {
      receive(result)
    }
  }

  async function initialize(service = new ConnectivityGatewayService()): Promise<void> {
    if (initialization) {
      return initialization
    }

    unsubscribe = service.onChanged(receive)

    if (typeof window !== 'undefined') {
      const onOnline = (): void => {
        void retry(service)
      }

      window.addEventListener('online', onOnline)
      removeOnlineListener = () => window.removeEventListener('online', onOnline)
    }

    const promise = applyIfFresh(service.getState()).catch((error: unknown) => {
      // A failed initial read must not permanently block a later initialize() call (e.g. a
      // remount) from retrying — only this attempt's promise rejects.
      initialization = null
      throw error
    })

    initialization = promise
    return promise
  }

  async function retry(service = new ConnectivityGatewayService()): Promise<void> {
    if (isRetrying.value) {
      return
    }

    isRetrying.value = true

    try {
      await applyIfFresh(service.checkNow())
    } finally {
      isRetrying.value = false
    }
  }

  function onBackendRestored(listener: () => void): () => void {
    restoredListeners.add(listener)
    return () => restoredListeners.delete(listener)
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    removeOnlineListener?.()
    removeOnlineListener = null
    clearCheckingTimer()
    clearRestoredTimer()
    restoredListeners.clear()
    initialization = null
    lastSettledStatus = undefined
  }

  return {
    snapshot,
    isRetrying,
    showOfflineWarning,
    showBackendUnavailableWarning,
    showCheckingHint,
    showRestoredToast,
    initialize,
    retry,
    dispose,
    onBackendRestored
  }
})
