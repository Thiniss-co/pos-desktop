import { describe, expect, it } from 'vitest'
import { connectivitySnapshotSchema } from '@shared/contracts/connectivity.contract'
import {
  connectivityCheckNowInputSchema,
  connectivityGetStateInputSchema
} from '@shared/validators/ipc.validators'
import { handleIpcRequest } from './handleIpcRequest'

// registerConnectivityIpcHandlers/broadcastConnectivityChanged themselves import `electron`
// (ipcMain, BrowserWindow), which is only a real API inside a running Electron process — so, like
// the other *.ipc.test.ts files in this directory, this exercises the same validation and
// serialization path the handlers use (handleIpcRequest + the shared schemas) without needing an
// Electron runtime.
describe('connectivity IPC validation', () => {
  it('rejects any input for getState — the renderer cannot supply a payload', async () => {
    const result = await handleIpcRequest(
      { url: 'https://attacker.example' },
      connectivityGetStateInputSchema,
      () => 'not called'
    )

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
  })

  it('rejects any input for checkNow — the renderer cannot supply a payload', async () => {
    const result = await handleIpcRequest(
      { timeoutMs: 1 },
      connectivityCheckNowInputSchema,
      () => 'not called'
    )

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
  })

  it('accepts undefined input and returns a snapshot parsed through the shared schema', async () => {
    const snapshot = connectivitySnapshotSchema.parse({
      status: 'online',
      networkAvailable: true,
      backendReachable: true,
      checkedAt: '2026-01-01T00:00:00Z',
      lastBackendReachableAt: '2026-01-01T00:00:00Z',
      reason: 'probe_succeeded'
    })

    const result = await handleIpcRequest(undefined, connectivityGetStateInputSchema, () =>
      connectivitySnapshotSchema.parse(snapshot)
    )

    expect(result).toEqual({ ok: true, data: snapshot })
  })
})
