// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SyncFailure, SyncFailurePage, SyncStatus } from '@shared/contracts/sync.contract'
import { SyncService, type SyncGateway } from './service'
import { useSyncStore } from './store'

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    state: 'idle',
    pausedReason: null,
    counts: { pending: 0, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 },
    ...overrides
  }
}

function failure(n: string, overrides: Partial<SyncFailure> = {}): SyncFailure {
  return {
    localQueueUuid: `00000000-0000-4000-8000-00000000000${n}`,
    invoiceLocalUuid: `00000000-0000-4000-8000-00000000001${n}`,
    offlineNumber: `POS-0000${n}`,
    totalAmount: 1000,
    currency: 'USD',
    currencyExponent: 2,
    soldAt: '2026-09-03T10:00:00.000Z',
    cashierUuid: '44444444-4444-4444-8444-444444444444',
    shiftUuid: '99999999-9999-4999-8999-999999999999',
    state: 'rejected',
    backendCode: 'DESKTOP_ALLOCATION_PROOF_REQUIRED',
    message: 'Allocation proof is required.',
    traceId: `trace-${n}`,
    queuedAt: '2026-09-03T10:00:00.000Z',
    ...overrides
  }
}

function service(overrides: Partial<SyncGateway> = {}): SyncService {
  return new SyncService({
    getStatus: async () => ({ ok: true, data: status() }),
    uploadNow: async () => ({ ok: true, data: status() }),
    listFailures: async () => ({ ok: true, data: { items: [], nextCursor: null } }),
    onChanged: () => () => {},
    ...overrides
  } as SyncGateway)
}

describe('useSyncStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('subscribes before the first read so a push during startup is not lost', async () => {
    const pushes: Array<(next: SyncStatus) => void> = []
    const store = useSyncStore()

    await store.initialize(
      service({
        onChanged: (listener) => {
          pushes.push(listener)
          return () => {}
        }
      })
    )

    expect(pushes).toHaveLength(1)
  })

  it('does not let a slow initial read overwrite a newer pushed status', async () => {
    const pushes: Array<(next: SyncStatus) => void> = []
    const releases: Array<() => void> = []
    const store = useSyncStore()
    const pending = new Promise<void>((resolve) => {
      releases.push(resolve)
    })

    const initialization = store.initialize(
      service({
        onChanged: (listener) => {
          pushes.push(listener)
          return () => {}
        },
        getStatus: async () => {
          await pending

          return {
            ok: true,
            data: status({
              counts: { pending: 99, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
            })
          }
        }
      })
    )

    // A push lands while the initial read is still in flight.
    pushes[0]?.(status({ state: 'paused', pausedReason: 'offline' }))
    releases[0]?.()
    await initialization

    // The newer pushed status wins; the stale read is discarded.
    expect(store.status?.state).toBe('paused')
    expect(store.status?.pausedReason).toBe('offline')
    expect(store.status?.counts.pending).toBe(0)
  })

  it('applies a pushed status to the live counts', async () => {
    const pushes: Array<(next: SyncStatus) => void> = []
    const store = useSyncStore()

    await store.initialize(
      service({
        onChanged: (listener) => {
          pushes.push(listener)
          return () => {}
        }
      })
    )

    pushes[0]?.(
      status({
        state: 'paused',
        pausedReason: 'permission-denied',
        counts: { pending: 4, uploading: 1, retryableError: 2, conflict: 3, rejected: 5 }
      })
    )

    expect(store.isPaused).toBe(true)
    expect(store.pausedReason).toBe('permission-denied')
    expect(store.queuedCount).toBe(7)
    expect(store.failedCount).toBe(8)
  })

  it('keeps the last valid status when a refresh fails', async () => {
    const store = useSyncStore()

    await store.initialize(
      service({
        getStatus: async () => ({
          ok: true,
          data: status({
            counts: { pending: 3, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
          })
        })
      })
    )
    expect(store.queuedCount).toBe(3)

    await store.refresh(
      service({
        getStatus: async () => ({
          ok: false,
          error: { category: 'transport', message: 'offline', retryable: true }
        })
      })
    )

    // Showing "0 queued" because a read failed would be worse than showing a slightly stale count.
    expect(store.queuedCount).toBe(3)
    expect(store.error).not.toBeNull()
  })

  it('resets the uploading flag on success and on failure', async () => {
    const store = useSyncStore()

    await store.uploadNow(service())
    expect(store.isUploading).toBe(false)

    await store.uploadNow(
      service({
        uploadNow: async () => ({
          ok: false,
          error: { category: 'transport', message: 'nope', retryable: true }
        })
      })
    )
    expect(store.isUploading).toBe(false)
    expect(store.error).not.toBeNull()
  })

  it('runs only one upload request at a time', async () => {
    const uploadNow = vi.fn(async () => ({ ok: true as const, data: status() }))
    const store = useSyncStore()
    const gateway = service({ uploadNow })

    await Promise.all([
      store.uploadNow(gateway),
      store.uploadNow(gateway),
      store.uploadNow(gateway)
    ])

    expect(uploadNow).toHaveBeenCalledTimes(1)
  })

  it('never mutates queue state optimistically when an upload is requested', async () => {
    const store = useSyncStore()

    await store.initialize(
      service({
        getStatus: async () => ({
          ok: true,
          data: status({
            counts: { pending: 2, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
          })
        })
      })
    )
    await store.uploadNow(
      service({
        uploadNow: async () => ({
          ok: true,
          data: status({
            counts: { pending: 2, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
          })
        })
      })
    )

    // The renderer reports what main says; it never predicts a drain.
    expect(store.queuedCount).toBe(2)
  })

  it('loads the first failure page and then appends by cursor', async () => {
    const cursor = {
      createdAt: '2026-09-03T10:00:00.000Z',
      localQueueUuid: failure('1').localQueueUuid
    }
    const pages: SyncFailurePage[] = [
      { items: [failure('1')], nextCursor: cursor },
      { items: [failure('2')], nextCursor: null }
    ]
    const listFailures = vi.fn(async () => ({ ok: true as const, data: pages.shift()! }))
    const store = useSyncStore()

    await store.loadFailures(service({ listFailures }))
    expect(store.failures).toHaveLength(1)
    expect(store.hasMoreFailures).toBe(true)
    expect(listFailures).toHaveBeenLastCalledWith(null)

    await store.loadMoreFailures(service({ listFailures }))
    expect(store.failures).toHaveLength(2)
    expect(store.hasMoreFailures).toBe(false)
    expect(listFailures).toHaveBeenLastCalledWith(cursor)
  })

  it('does not request another page when there is no cursor', async () => {
    const listFailures = vi.fn(async () => ({
      ok: true as const,
      data: { items: [], nextCursor: null }
    }))
    const store = useSyncStore()

    await store.loadMoreFailures(service({ listFailures }))

    expect(listFailures).not.toHaveBeenCalled()
  })

  it('surfaces a failure-list error without clearing the status', async () => {
    const store = useSyncStore()

    await store.initialize(service())
    await store.loadFailures(
      service({
        listFailures: async () => ({
          ok: false,
          error: { category: 'unexpected', message: 'nope', retryable: false }
        })
      })
    )

    expect(store.failureError).not.toBeNull()
    expect(store.status).not.toBeNull()
  })

  it('unsubscribes and clears every field on dispose', async () => {
    const unsubscribe = vi.fn()
    const store = useSyncStore()

    await store.initialize(
      service({
        onChanged: () => unsubscribe,
        getStatus: async () => ({
          ok: true,
          data: status({
            counts: { pending: 7, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
          })
        })
      })
    )
    await store.loadFailures(
      service({
        listFailures: async () => ({ ok: true, data: { items: [failure('1')], nextCursor: null } })
      })
    )

    store.dispose()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(store.status).toBeNull()
    expect(store.failures).toEqual([])
    expect(store.queuedCount).toBe(0)
    expect(store.hasMoreFailures).toBe(false)
  })
})
