import { describe, expect, it, vi } from 'vitest'
import type { SyncFailureCursor, SyncStatus } from '@shared/contracts/sync.contract'
import { SyncService, type SyncGateway } from './service'

const IDLE_STATUS: SyncStatus = {
  state: 'idle',
  pausedReason: null,
  counts: { pending: 0, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
}

function gateway(overrides: Partial<SyncGateway> = {}): SyncGateway {
  return {
    getStatus: async () => ({ ok: true, data: IDLE_STATUS }),
    uploadNow: async () => ({ ok: true, data: IDLE_STATUS }),
    listFailures: async () => ({ ok: true, data: { items: [], nextCursor: null } }),
    onChanged: () => () => {},
    ...overrides
  } as SyncGateway
}

describe('SyncService', () => {
  it('returns sanitized sync status from the named preload capability', async () => {
    const service = new SyncService(
      gateway({
        getStatus: async () => ({
          ok: true,
          data: {
            state: 'idle',
            pausedReason: null,
            counts: { pending: 0, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
          }
        })
      })
    )

    await expect(service.getStatus()).resolves.toMatchObject({ state: 'idle' })
  })

  it('returns the paused status and reason without interpreting it', async () => {
    const service = new SyncService(
      gateway({
        getStatus: async () => ({
          ok: true,
          data: {
            state: 'paused',
            pausedReason: 'permission-denied',
            counts: { pending: 3, uploading: 0, retryableError: 1, conflict: 0, rejected: 2 }
          }
        })
      })
    )

    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'paused',
      pausedReason: 'permission-denied'
    })
  })

  it('requests an upload through the named capability and returns the resulting status', async () => {
    const uploadNow = vi.fn(async () => ({ ok: true as const, data: IDLE_STATUS }))
    const service = new SyncService(gateway({ uploadNow }))

    await expect(service.uploadNow()).resolves.toMatchObject({ state: 'idle' })
    expect(uploadNow).toHaveBeenCalledTimes(1)
    // No argument: the renderer cannot name a row, an owner, or an authority.
    expect(uploadNow).toHaveBeenCalledWith()
  })

  it('passes only the cursor when listing failures, and null on the first page', async () => {
    const listFailures = vi.fn(async () => ({
      ok: true as const,
      data: { items: [], nextCursor: null }
    }))
    const service = new SyncService(gateway({ listFailures }))

    await service.listFailures()
    expect(listFailures).toHaveBeenCalledWith(null)

    const cursor: SyncFailureCursor = {
      createdAt: '2026-09-03T10:00:00.000Z',
      localQueueUuid: '00000000-0000-4000-8000-000000000001'
    }
    await service.listFailures(cursor)
    expect(listFailures).toHaveBeenCalledWith(cursor)
  })

  it('surfaces a sanitized failure instead of resolving when the result is not ok', async () => {
    const service = new SyncService(
      gateway({
        getStatus: async () => ({
          ok: false,
          error: {
            category: 'unexpected',
            message: 'The request could not be completed',
            retryable: false
          }
        })
      })
    )

    await expect(service.getStatus()).rejects.toMatchObject({ category: 'unexpected' })
  })

  it('forwards the unsubscribe function from the push subscription unchanged', () => {
    const unsubscribe = vi.fn()
    const service = new SyncService(gateway({ onChanged: () => unsubscribe }))

    service.onChanged(() => {})()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
