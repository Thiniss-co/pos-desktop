import { describe, expect, it } from 'vitest'
import { syncStatusSchema } from '@shared/contracts/sync.contract'
import { syncGetStatusInputSchema } from '@shared/validators/ipc.validators'
import { handleIpcRequest } from './handleIpcRequest'

// Like the other *.ipc.test.ts files here, this exercises the validation and serialization path the
// handler uses (handleIpcRequest + the shared schema) without needing an Electron runtime.
describe('sync IPC validation', () => {
  const counts = { pending: 3, uploading: 1, retryableError: 2, conflict: 1, rejected: 0 }

  it('rejects any input — the renderer cannot supply a payload', async () => {
    const result = await handleIpcRequest(
      { pausedReason: 'license-denied' },
      syncGetStatusInputSchema,
      () => 'not called'
    )

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
  })

  it('returns an idle status with real queue counts', async () => {
    const result = await handleIpcRequest(undefined, syncGetStatusInputSchema, () =>
      syncStatusSchema.parse({ state: 'idle', pausedReason: null, counts })
    )

    expect(result).toMatchObject({ ok: true, data: { state: 'idle', pausedReason: null, counts } })
  })

  it('carries the worker pause and its reason through to the renderer', async () => {
    // The reason the handler reads the worker rather than the queue repository: a licence-blocked
    // queue reported as 'idle' would look healthy while nothing uploads.
    const result = await handleIpcRequest(undefined, syncGetStatusInputSchema, () =>
      syncStatusSchema.parse({ state: 'paused', pausedReason: 'license-denied', counts })
    )

    expect(result).toMatchObject({
      ok: true,
      data: { state: 'paused', pausedReason: 'license-denied' }
    })
  })

  it('refuses a status shape the contract does not allow', async () => {
    // There is no seventh state and no per-item pause; the schema is the guard.
    const result = await handleIpcRequest(undefined, syncGetStatusInputSchema, () =>
      syncStatusSchema.parse({ state: 'quarantined', pausedReason: null, counts })
    )

    expect(result).toMatchObject({ ok: false })
  })
})
