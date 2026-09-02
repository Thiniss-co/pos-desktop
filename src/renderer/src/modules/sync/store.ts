import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import type { SyncFailure, SyncFailureCursor, SyncStatus } from '@shared/contracts/sync.contract'
import type { SyncDisplayState } from './types'
import { SyncService } from './service'

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncDisplayState>(null)
  const failures = ref<SyncFailure[]>([])
  const nextCursor = ref<SyncFailureCursor | null>(null)
  const isUploading = ref(false)
  const isLoadingFailures = ref(false)
  const errorState = createLocalizedErrorRef()
  const failureErrorState = createLocalizedErrorRef()
  const error = errorState.error
  const failureError = failureErrorState.error

  let unsubscribe: (() => void) | null = null
  // Incremented on every applied status, pushed or fetched. A `getStatus()` reply is applied only
  // if no push landed while it was in flight — otherwise a slow initial read would overwrite the
  // newer pushed state and leave the operator looking at stale counts.
  let sequence = 0
  // Guards the failure list against interleaved page loads resolving out of order.
  let failureSequence = 0

  const queuedCount = computed(() => {
    const counts = status.value?.counts

    return counts ? counts.pending + counts.uploading + counts.retryableError : 0
  })
  const failedCount = computed(() => {
    const counts = status.value?.counts

    return counts ? counts.conflict + counts.rejected : 0
  })
  const isPaused = computed(() => status.value?.state === 'paused')
  const pausedReason = computed(() => status.value?.pausedReason ?? null)
  const hasMoreFailures = computed(() => nextCursor.value !== null)

  function receive(next: SyncStatus): void {
    sequence += 1
    status.value = next
    errorState.clear()
  }

  function captureError(cause: unknown, target: typeof errorState, fallbackKey: string): void {
    void handleSessionTransition(cause)
    const parsed = publicAppErrorSchema.safeParse(cause)

    if (parsed.success) {
      target.setDetail(parsed.data)
    } else {
      target.setFallbackKey(fallbackKey)
    }
  }

  /** Applies a fetched status only when no push has been received since the read started. */
  async function applyIfFresh(promise: Promise<SyncStatus>): Promise<void> {
    const requestedAt = sequence
    const result = await promise

    if (sequence === requestedAt) {
      receive(result)
    }
  }

  async function refresh(service = new SyncService()): Promise<void> {
    try {
      await applyIfFresh(service.getStatus())
    } catch (cause) {
      // A failed read must never blank the last good status: an operator acting on a stale count
      // is recoverable, an operator shown "0 queued" because a read failed is not.
      captureError(cause, errorState, 'sync.statusUnavailable')
    }
  }

  /**
   * Subscribes *before* the first read, so a push that arrives during that read is not lost. The
   * sequence guard then decides which of the two wins.
   */
  async function initialize(service = new SyncService()): Promise<void> {
    if (!unsubscribe) {
      unsubscribe = service.onChanged(receive)
    }

    await refresh(service)
  }

  async function uploadNow(service = new SyncService()): Promise<void> {
    if (isUploading.value) {
      return
    }

    isUploading.value = true

    try {
      await applyIfFresh(service.uploadNow())
    } catch (cause) {
      captureError(cause, errorState, 'sync.uploadUnavailable')
    } finally {
      // Reset on every path: a stuck spinner would make the operator believe an upload is still
      // running when nothing is.
      isUploading.value = false
    }
  }

  async function loadFailures(service = new SyncService(), append = false): Promise<void> {
    if (isLoadingFailures.value) {
      return
    }

    isLoadingFailures.value = true
    const requestedAt = ++failureSequence
    const cursor = append ? nextCursor.value : null

    try {
      const page = await service.listFailures(cursor)

      if (failureSequence !== requestedAt) {
        return
      }

      failures.value = append ? [...failures.value, ...page.items] : page.items
      nextCursor.value = page.nextCursor
      failureErrorState.clear()
    } catch (cause) {
      captureError(cause, failureErrorState, 'sync.failuresUnavailable')
    } finally {
      isLoadingFailures.value = false
    }
  }

  async function loadMoreFailures(service = new SyncService()): Promise<void> {
    if (nextCursor.value === null) {
      return
    }

    await loadFailures(service, true)
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    status.value = null
    failures.value = []
    nextCursor.value = null
    isUploading.value = false
    isLoadingFailures.value = false
    sequence = 0
    failureSequence = 0
    errorState.clear()
    failureErrorState.clear()
  }

  return {
    status,
    failures,
    error,
    failureError,
    isUploading,
    isLoadingFailures,
    queuedCount,
    failedCount,
    isPaused,
    pausedReason,
    hasMoreFailures,
    initialize,
    refresh,
    uploadNow,
    loadFailures,
    loadMoreFailures,
    dispose
  }
})
