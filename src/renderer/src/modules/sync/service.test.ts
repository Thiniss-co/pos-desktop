import { describe, expect, it } from 'vitest'
import { SyncService } from './service'

describe('SyncService', () => {
  it('returns sanitized sync status from the named preload capability', async () => {
    const service = new SyncService({
      getStatus: async () => ({
        ok: true,
        data: {
          state: 'idle',
          pausedReason: null,
          counts: { pending: 0, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
        }
      })
    })

    await expect(service.getStatus()).resolves.toMatchObject({ state: 'idle' })
  })
})
