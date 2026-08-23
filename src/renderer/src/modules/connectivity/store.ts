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
    const previousStatus = snapshot.value?.status
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

    if (previousStatus === 'offline' && nextSnapshot.status === 'online') {
      clearRestoredTimer()
      isRestoredToastVisible.value = true
      restoredTimer = setTimeout(() => {
        isRestoredToastVisible.value = false
      }, RESTORED_TOAST_DURATION_MS)
    }

    if (previousStatus === 'backend_unreachable' && nextSnapshot.status === 'online') {
      for (const listener of restoredListeners) {
        listener()
      }
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

    initialization = service.getState().then(receive)
    return initialization
  }

  async function retry(service = new ConnectivityGatewayService()): Promise<void> {
    if (isRetrying.value) {
      return
    }

    isRetrying.value = true

    try {
      receive(await service.checkNow())
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
