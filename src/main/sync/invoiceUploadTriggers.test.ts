import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncStatus } from '@shared/contracts/sync.contract'
import { CommercialAccessPublisher } from '../ipc/license.ipc'
import { payloadHash } from '../services/localSale.fingerprint'
import { InvoiceUploadWorker } from './invoiceUploadWorker'
import { subscribeInvoiceUploadTriggers } from './invoiceUploadTriggers'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() }
}))

const COMPANY = '11111111-1111-4111-8111-111111111111'
const DEVICE = '33333333-3333-4333-8333-333333333333'
const ALLOWED_DECISION = {
  allowed: true,
  reason: null,
  warning: null,
  action: 'sync' as const,
  retryable: false,
  evaluatedAt: null,
  nextValidationDueAt: null,
  restrictionLevel: null,
  warningMessage: null
}
const ACCESS_SNAPSHOT = {
  sell: { ...ALLOWED_DECISION, action: 'sell' as const },
  sync: ALLOWED_DECISION
}

function accessDeniedError(): unknown {
  return {
    category: 'authorization',
    message: 'Sync is not permitted.',
    retryable: false,
    backendCode: 'COMMERCIAL_ACCESS_LICENSE_EXPIRED'
  }
}

/**
 * A worker built from the real production class over an in-memory queue double. Only the SQLite
 * repository and the HTTP dispatch are substituted — the authorization gate, the single-flight
 * drain and the pause logic are the shipped ones.
 */
function buildWorker(options: { canSync: () => boolean }): {
  readonly worker: InvoiceUploadWorker
  readonly uploads: string[]
  readonly claimable: { value: number }
} {
  const uploads: string[] = []
  const claimable = { value: 1 }
  const payloadJson = '{}'
  // The real integrity check runs; the double must present a genuinely matching hash.
  const hash = payloadHash(JSON.parse(payloadJson))

  const worker = new InvoiceUploadWorker({
    syncQueue: {
      reclaimExpiredUploadLeases: () => [],
      releaseDueRetries: () => {},
      claimNextInvoiceUpload: () => {
        if (claimable.value <= 0) {
          return null
        }

        claimable.value -= 1

        return {
          localQueueUuid: '00000000-0000-4000-8000-000000000001',
          invoiceLocalUuid: '00000000-0000-4000-8000-000000000002',
          payloadJson,
          payloadHash: hash,
          idempotencyKey: '00000000-0000-4000-8000-000000000002',
          attemptCount: 1
        }
      },
      countForeignPendingUploads: () => 0,
      // Mirrors the real repository: the pause is the worker's, and getStatus reports what it is
      // told rather than inventing a state of its own.
      getStatus: (pausedReason: string | null = null): SyncStatus => ({
        state: pausedReason === null ? 'idle' : 'paused',
        pausedReason,
        counts: { pending: 1, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
      })
    } as never,
    recorder: { record: () => {} } as never,
    commercialAccess: {
      assertAllowed: () => {
        if (!options.canSync()) {
          throw accessDeniedError()
        }
      }
    },
    permissions: { hasPermission: () => true },
    session: {
      getContext: () => ({ isAuthenticated: true, companyUuid: COMPANY, deviceUuid: DEVICE })
    },
    upload: async (dispatched) => {
      uploads.push(dispatched)

      return {
        kind: 'created',
        invoice: { id: '00000000-0000-4000-8000-0000000000aa', server_number: 'POS-1' }
      } as never
    },
    now: () => new Date('2026-09-03T10:00:00.000Z')
  })

  return { worker, uploads, claimable }
}

describe('invoice upload trigger wiring (CP-3G-4A)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('is the wiring the production composition root actually uses', () => {
    // Guards the one line the functional tests below cannot execute themselves: that
    // `createApplicationServices` subscribes the worker through this exact function, and disposes
    // it on shutdown. Without this, a green trigger test could coexist with dead production wiring
    // — which is the precise defect CP-3G-4A exists to close.
    const composition = readFileSync(
      new URL('../app/applicationServices.ts', import.meta.url),
      'utf8'
    )

    expect(composition).toContain('subscribeInvoiceUploadTriggers')
    expect(composition).toMatch(
      /const unsubscribeAccessTrigger = subscribeInvoiceUploadTriggers\(\{\s*accessPublisher: commercialAccessPublisher,\s*worker: invoiceUploads\s*\}\)/
    )
    expect(composition).toMatch(/shutdown: \(\) => \{\s*unsubscribeAccessTrigger\(\)/)
  })

  it('resumes a paused worker when access is restored, with connectivity unchanged', async () => {
    let canSync = false
    const { worker, uploads } = buildWorker({ canSync: () => canSync })
    // The real publisher, driven exactly as licence validation and bootstrap-refresh drive it.
    const publisher = new CommercialAccessPublisher({ describe: () => ACCESS_SNAPSHOT })
    subscribeInvoiceUploadTriggers({ accessPublisher: publisher, worker })

    await worker.run()
    expect(worker.getStatus().state).toBe('paused')
    expect(uploads).toHaveLength(0)

    // Authority comes back. Connectivity never changed, no restart, no new sale, no manual press.
    canSync = true
    publisher.publishCurrent()
    await vi.waitFor(() => expect(uploads).toHaveLength(1))

    expect(worker.getStatus().state).toBe('idle')
  })

  it('sends nothing when the access signal fires while authority is still denied', async () => {
    const { worker, uploads } = buildWorker({ canSync: () => false })
    const publisher = new CommercialAccessPublisher({ describe: () => ACCESS_SNAPSHOT })
    subscribeInvoiceUploadTriggers({ accessPublisher: publisher, worker })

    publisher.publishCurrent()
    publisher.publishCurrent()
    await new Promise((resolve) => setTimeout(resolve, 10))

    // The hint scheduled a drain; the gate re-evaluated and refused. Zero dispatches.
    expect(uploads).toHaveLength(0)
    expect(worker.getStatus().state).toBe('paused')
  })

  it('collapses a burst of access publications into a single drain', async () => {
    const { worker, uploads, claimable } = buildWorker({ canSync: () => true })
    const publisher = new CommercialAccessPublisher({ describe: () => ACCESS_SNAPSHOT })
    subscribeInvoiceUploadTriggers({ accessPublisher: publisher, worker })

    claimable.value = 1
    publisher.publishCurrent()
    publisher.publishCurrent()
    publisher.publishCurrent()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Single-flight: the one claimable row goes out exactly once, never three times.
    expect(uploads).toHaveLength(1)
  })

  it('stops scheduling once the subscription is disposed', async () => {
    const { worker, uploads, claimable } = buildWorker({ canSync: () => true })
    const publisher = new CommercialAccessPublisher({ describe: () => ACCESS_SNAPSHOT })
    const dispose = subscribeInvoiceUploadTriggers({ accessPublisher: publisher, worker })

    dispose()
    claimable.value = 1
    publisher.publishCurrent()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(uploads).toHaveLength(0)
  })

  it('registers one listener per subscription, so repeated wiring cannot double-dispatch', () => {
    const runs: number[] = []
    const worker = { requestRun: () => runs.push(1) }
    const publisher = new CommercialAccessPublisher({ describe: () => ACCESS_SNAPSHOT })

    const first = subscribeInvoiceUploadTriggers({ accessPublisher: publisher, worker })
    publisher.publishCurrent()
    expect(runs).toHaveLength(1)

    // A second services instance subscribes its own worker; disposing the first must not silence
    // the second, and must leave exactly one live listener behind.
    const second = subscribeInvoiceUploadTriggers({ accessPublisher: publisher, worker })
    first()
    publisher.publishCurrent()
    expect(runs).toHaveLength(2)

    second()
    publisher.publishCurrent()
    expect(runs).toHaveLength(2)
  })

  it('never lets a listener failure break access publication for the renderer', () => {
    const publisher = new CommercialAccessPublisher({ describe: () => ACCESS_SNAPSHOT })
    const healthy = vi.fn()

    subscribeInvoiceUploadTriggers({
      accessPublisher: publisher,
      worker: {
        requestRun: () => {
          throw new Error('scheduling exploded')
        }
      }
    })
    publisher.onPublished(healthy)

    expect(() => publisher.publishCurrent()).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
  })
})
