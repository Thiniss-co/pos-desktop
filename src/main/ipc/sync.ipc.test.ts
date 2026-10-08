import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { rendererIndexUrl } from '../security/securityPolicy'
import { syncStatusSchema } from '@shared/contracts/sync.contract'
import {
  syncGetStatusInputSchema,
  syncListFailuresInputSchema,
  syncUploadNowInputSchema
} from '@shared/validators/ipc.validators'
import { handleIpcRequest } from './handleIpcRequest'

const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
const inboundListeners = new Map<string, unknown>()
const sentPayloads: Array<{ readonly channel: string; readonly payload: unknown }> = []
const windows: Array<{
  isDestroyed(): boolean
  webContents: { send(c: string, p: unknown): void }
}> = []

// `assertTrustedSender` pulls in the security policy, which reads the dev-renderer flag.
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input: unknown) => unknown) => {
      handlers.set(channel, handler)
    },
    on: (channel: string, listener: unknown) => {
      inboundListeners.set(channel, listener)
    }
  },
  BrowserWindow: { getAllWindows: () => windows }
}))

const { broadcastSyncChanged, registerSyncIpcHandlers } = await import('./sync.ipc')

const COUNTS = { pending: 3, uploading: 1, retryableError: 2, conflict: 1, rejected: 0 }
const IDLE = { state: 'idle' as const, pausedReason: null, counts: COUNTS }
const CURSOR = {
  createdAt: '2026-09-03T10:00:00.000Z',
  localQueueUuid: '00000000-0000-4000-8000-000000000001'
}

const EMPTY_SUPPORT = {
  needsSupport: [],
  automaticReconciliation: [],
  paymentAwaitingDecision: null
}
const CONFLICT_ISSUE = {
  kind: 'allocation-identity-conflict' as const,
  reference: 'AD-0123456789AB',
  traceId: 'trace-1',
  occurredAt: '2026-09-29T12:00:00.000Z',
  updatedAt: '2026-09-29T12:01:00.000Z',
  ownedByCurrentUser: false,
  lines: null,
  sendCount: null,
  nextAttemptAfter: null,
  relatedReference: null
}

/** A frame the allow-list accepts: no dev renderer URL is set, so `file:` is the trusted origin. */
const trustedEvent = { senderFrame: { parent: null, url: rendererIndexUrl().href } }
const untrustedEvent = { senderFrame: { parent: null, url: 'https://evil.example/index.html' } }
const subframeEvent = {
  senderFrame: { parent: { url: 'file:///app/index.html' }, url: 'file:///app/index.html' }
}

function buildServices(overrides: Record<string, unknown> = {}): never {
  return {
    invoiceUploads: {
      getStatus: () => IDLE,
      requestRun: vi.fn()
    },
    invoiceUploadFailures: {
      list: vi.fn(() => ({ items: [], nextCursor: null }))
    },
    supportIssues: {
      list: vi.fn(() => EMPTY_SUPPORT)
    },
    ...overrides
  } as never
}

async function invoke(channel: string, event: unknown, input: unknown): Promise<unknown> {
  const handler = handlers.get(channel)

  if (!handler) {
    throw new Error(`no handler registered for ${channel}`)
  }

  return handler(event, input)
}

beforeEach(() => {
  handlers.clear()
  inboundListeners.clear()
  sentPayloads.length = 0
  windows.length = 0
})

// Like the other *.ipc.test.ts files here, this exercises the validation and serialization path the
// handler uses (handleIpcRequest + the shared schema) without needing an Electron runtime.
describe('sync IPC validation', () => {
  const counts = COUNTS

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

  it('accepts exactly undefined for the upload trigger', () => {
    expect(syncUploadNowInputSchema.safeParse(undefined).success).toBe(true)
    expect(syncUploadNowInputSchema.safeParse({}).success).toBe(false)
    expect(syncUploadNowInputSchema.safeParse(null).success).toBe(false)
    expect(syncUploadNowInputSchema.safeParse('now').success).toBe(false)
  })

  it('accepts only the frozen bounded cursor contract for the failure list', () => {
    expect(syncListFailuresInputSchema.safeParse(undefined).success).toBe(true)
    expect(syncListFailuresInputSchema.safeParse({ cursor: null }).success).toBe(true)
    expect(syncListFailuresInputSchema.safeParse({ cursor: CURSOR }).success).toBe(true)
    expect(syncListFailuresInputSchema.safeParse({ cursor: CURSOR, limit: 10 }).success).toBe(true)

    // Extra keys, wrong types, malformed and oversized values are all refused.
    expect(
      syncListFailuresInputSchema.safeParse({ cursor: CURSOR, companyUuid: 'x' }).success
    ).toBe(false)
    expect(syncListFailuresInputSchema.safeParse({ cursor: { createdAt: 'nope' } }).success).toBe(
      false
    )
    expect(
      syncListFailuresInputSchema.safeParse({
        cursor: { createdAt: CURSOR.createdAt, localQueueUuid: 'not-a-uuid' }
      }).success
    ).toBe(false)
    expect(syncListFailuresInputSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(syncListFailuresInputSchema.safeParse({ limit: 5_000 }).success).toBe(false)
    expect(syncListFailuresInputSchema.safeParse({ limit: 2.5 }).success).toBe(false)
    expect(syncListFailuresInputSchema.safeParse({ cursor: CURSOR, extra: true }).success).toBe(
      false
    )
  })
})

describe('sync IPC handlers', () => {
  it('registers exactly the four invoke channels and no inbound push handler', () => {
    registerSyncIpcHandlers(buildServices())

    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.syncGetStatus,
        IPC_CHANNELS.syncListFailures,
        IPC_CHANNELS.syncSupportIssues,
        IPC_CHANNELS.syncUploadNow
      ].sort()
    )
    // `sync:changed` is main-to-renderer only: a renderer cannot publish or forge a status.
    expect(handlers.has(IPC_CHANNELS.syncChanged)).toBe(false)
    expect(inboundListeners.has(IPC_CHANNELS.syncChanged)).toBe(false)
  })

  it.each([
    ['status', IPC_CHANNELS.syncGetStatus],
    ['upload trigger', IPC_CHANNELS.syncUploadNow],
    ['failure list', IPC_CHANNELS.syncListFailures],
    ['support issues', IPC_CHANNELS.syncSupportIssues]
  ])('rejects an untrusted sender on the %s channel', async (_label, channel) => {
    const services = buildServices()
    registerSyncIpcHandlers(services)

    await expect(invoke(channel, untrustedEvent, undefined)).rejects.toMatchObject({
      category: 'authorization'
    })
    await expect(invoke(channel, subframeEvent, undefined)).rejects.toMatchObject({
      category: 'authorization'
    })
  })

  it('does not schedule an upload when the sender is untrusted', async () => {
    const services = buildServices()
    registerSyncIpcHandlers(services)

    await expect(
      invoke(IPC_CHANNELS.syncUploadNow, untrustedEvent, undefined)
    ).rejects.toBeDefined()

    expect(
      (services as never as { invoiceUploads: { requestRun: ReturnType<typeof vi.fn> } })
        .invoiceUploads.requestRun
    ).not.toHaveBeenCalled()
  })

  it('schedules a run for a trusted sender and answers with the sanitized status', async () => {
    const services = buildServices()
    registerSyncIpcHandlers(services)

    const result = await invoke(IPC_CHANNELS.syncUploadNow, trustedEvent, undefined)

    expect(result).toMatchObject({ ok: true, data: IDLE })
    expect(
      (services as never as { invoiceUploads: { requestRun: ReturnType<typeof vi.fn> } })
        .invoiceUploads.requestRun
    ).toHaveBeenCalledTimes(1)
  })

  it('never reaches the worker when the upload payload fails validation', async () => {
    const services = buildServices()
    registerSyncIpcHandlers(services)

    const result = await invoke(IPC_CHANNELS.syncUploadNow, trustedEvent, { force: true })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(
      (services as never as { invoiceUploads: { requestRun: ReturnType<typeof vi.fn> } })
        .invoiceUploads.requestRun
    ).not.toHaveBeenCalled()
  })

  it('never reaches the repository when the cursor fails validation', async () => {
    const services = buildServices()
    registerSyncIpcHandlers(services)

    const result = await invoke(IPC_CHANNELS.syncListFailures, trustedEvent, {
      cursor: { createdAt: 'nope', localQueueUuid: 'also-nope' }
    })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(
      (services as never as { invoiceUploadFailures: { list: ReturnType<typeof vi.fn> } })
        .invoiceUploadFailures.list
    ).not.toHaveBeenCalled()
  })

  it('passes only the cursor and limit to the reader — never an owner', async () => {
    const services = buildServices()
    registerSyncIpcHandlers(services)

    await invoke(IPC_CHANNELS.syncListFailures, trustedEvent, { cursor: CURSOR, limit: 10 })

    const list = (
      services as never as { invoiceUploadFailures: { list: ReturnType<typeof vi.fn> } }
    ).invoiceUploadFailures.list

    expect(list).toHaveBeenCalledWith(CURSOR, 10)
  })

  it('surfaces a sanitized error rather than an internal one when the reader throws', async () => {
    const services = buildServices({
      invoiceUploadFailures: {
        list: () => {
          throw new Error('SQLITE_ERROR: no such column: secret_token')
        }
      }
    })
    registerSyncIpcHandlers(services)

    const result = await invoke(IPC_CHANNELS.syncListFailures, trustedEvent, undefined)

    expect(result).toMatchObject({ ok: false, error: { category: 'unexpected' } })
    expect(JSON.stringify(result)).not.toContain('SQLITE_ERROR')
    expect(JSON.stringify(result)).not.toContain('secret_token')
  })
})

describe('sync support-issues IPC', () => {
  it('takes no argument: any payload is refused before the projection is read', async () => {
    const services = buildServices() as unknown as {
      supportIssues: { list: ReturnType<typeof vi.fn> }
    }
    registerSyncIpcHandlers(services as never)

    const result = await invoke(IPC_CHANNELS.syncSupportIssues, trustedEvent, {
      companyUuid: '11111111-1111-4111-8111-111111111111'
    })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(services.supportIssues.list).not.toHaveBeenCalled()
  })

  it('returns the validated read-only projection to a trusted sender', async () => {
    const payload = { ...EMPTY_SUPPORT, needsSupport: [CONFLICT_ISSUE] }
    registerSyncIpcHandlers(buildServices({ supportIssues: { list: () => payload } }))

    await expect(invoke(IPC_CHANNELS.syncSupportIssues, trustedEvent, undefined)).resolves.toEqual({
      ok: true,
      data: payload
    })
  })

  it('refuses a projection that would leak details outside the contract', async () => {
    registerSyncIpcHandlers(
      buildServices({
        supportIssues: {
          list: () => ({
            ...EMPTY_SUPPORT,
            needsSupport: [{ ...CONFLICT_ISSUE, requestBody: { items: [] } }]
          })
        }
      })
    )

    const result = await invoke(IPC_CHANNELS.syncSupportIssues, trustedEvent, undefined)
    expect(result).toMatchObject({ ok: false })
  })
})

describe('sync status broadcast', () => {
  it('sends the sanitized status to every live window and skips destroyed ones', () => {
    windows.push(
      {
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => sentPayloads.push({ channel, payload }) }
      },
      {
        isDestroyed: () => true,
        webContents: {
          send: () => {
            throw new Error('a destroyed window must never be sent to')
          }
        }
      }
    )

    broadcastSyncChanged(IDLE)

    expect(sentPayloads).toEqual([{ channel: IPC_CHANNELS.syncChanged, payload: IDLE }])
  })

  it('does not let one window teardown race stop delivery to the others', () => {
    windows.push(
      {
        isDestroyed: () => false,
        webContents: {
          send: () => {
            throw new Error('render frame was disposed')
          }
        }
      },
      {
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => sentPayloads.push({ channel, payload }) }
      }
    )

    expect(() => broadcastSyncChanged(IDLE)).not.toThrow()
    expect(sentPayloads).toHaveLength(1)
  })

  it('refuses to broadcast a status the contract does not allow', () => {
    expect(() =>
      broadcastSyncChanged({ state: 'quarantined', pausedReason: null, counts: COUNTS } as never)
    ).toThrow()
  })
})
