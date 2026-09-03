import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  SYNC_QUEUE_TRANSITIONS,
  isSyncQueueTransitionAllowed
} from '@shared/constants/syncQueueStates'
import { CommercialAccessPublisher } from '../ipc/license.ipc'
import { payloadHash } from '../services/localSale.fingerprint'
import { subscribeInvoiceUploadTriggers } from './invoiceUploadTriggers'
import { InvoiceUploadWorker } from './invoiceUploadWorker'
import { isUploadLeaseExpired } from './syncPolicy'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() }
}))

const projectRoot = resolve(process.cwd())
const COMPANY = '11111111-1111-4111-8111-111111111111'
const DEVICE = '33333333-3333-4333-8333-333333333333'
const INVOICE = '00000000-0000-4000-8000-000000000002'
const ALLOWED = {
  allowed: true,
  reason: null,
  warning: null,
  retryable: false,
  evaluatedAt: null,
  nextValidationDueAt: null,
  restrictionLevel: null,
  warningMessage: null
}

function source(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8')
}

/**
 * CP-3G-6 — the parts of crash recovery that are contracts rather than database states.
 *
 * The real `SIGKILL`, the reopened database and the live convergence live in
 * `tests/electron/suites/invoiceUploadCrashRecovery.suite.ts`. What is pinned here is what that
 * suite cannot observe from a sandbox: that the frozen transition table still forbids the shortcut
 * a reclaim is often mistaken for, that production actually runs a reclaim at startup, and that a
 * disposed worker leaves no timer or subscription behind to dispatch after a restart.
 */
describe('CP-3G-6 — crash-recovery contracts', () => {
  it('keeps the frozen state machine free of a direct uploading -> pending transition', () => {
    expect(isSyncQueueTransitionAllowed('uploading', 'pending')).toBe(false)
    expect(SYNC_QUEUE_TRANSITIONS.uploading).toEqual([
      'synced',
      'retryable_error',
      'conflict',
      'rejected'
    ])
    expect(SYNC_QUEUE_TRANSITIONS.retryable_error).toEqual(['pending'])
    expect(SYNC_QUEUE_TRANSITIONS.synced).toEqual([])
    expect(SYNC_QUEUE_TRANSITIONS.conflict).toEqual([])
    expect(SYNC_QUEUE_TRANSITIONS.rejected).toEqual([])
  })

  it('treats a missing or unreadable lease as expired and honours the frozen 60s boundary', () => {
    const leaseAt = '2026-09-03T10:00:00.000Z'
    const startedAt = Date.parse(leaseAt)

    expect(isUploadLeaseExpired(null, new Date(startedAt))).toBe(true)
    expect(isUploadLeaseExpired('not-a-date', new Date(startedAt))).toBe(true)
    expect(isUploadLeaseExpired(leaseAt, new Date(startedAt))).toBe(false)
    expect(isUploadLeaseExpired(leaseAt, new Date(startedAt + 59_999))).toBe(false)
    expect(isUploadLeaseExpired(leaseAt, new Date(startedAt + 60_000))).toBe(true)
    expect(isUploadLeaseExpired(leaseAt, new Date(startedAt + 60_001))).toBe(true)
  })

  it('reclaims expired leases at the start of every drain, before anything is claimed', () => {
    const worker = source('src/main/sync/invoiceUploadWorker.ts')
    const reclaimAt = worker.indexOf('reclaimExpiredUploadLeases(')
    const releaseAt = worker.indexOf('releaseDueRetries(')
    const claimAt = worker.indexOf('claimNextInvoiceUpload(')

    expect(reclaimAt).toBeGreaterThan(-1)
    expect(reclaimAt).toBeLessThan(releaseAt)
    expect(releaseAt).toBeLessThan(claimAt)
    expect(worker).toContain('isUploadLeaseExpired(leaseAt, now, UPLOAD_LEASE_DURATION_MS)')
    expect(worker).toContain('const UPLOAD_LEASE_DURATION_MS = 60_000')
  })

  it('carries the company and device predicate inside the reclaim and release updates', () => {
    const repository = source('src/main/repositories/syncQueue.repository.ts')
    const updates = repository.match(/UPDATE sync_queue[\s\S]*?`/g) ?? []
    const ownerGuard =
      /EXISTS \(\s*SELECT 1 FROM local_invoices i\s*WHERE i\.local_uuid = sync_queue\.local_aggregate_uuid\s*AND i\.company_uuid = \? AND i\.device_uuid = \?/

    const reclaimUpdate = updates.find((sql) =>
      sql.includes("state = 'retryable_error', upload_lease_at = NULL")
    )
    const releaseUpdate = updates.find((sql) => sql.includes("SET state = 'pending'"))

    // The predicate must be in the write, not only in the read that chose the row: a row that stops
    // being ours between the two must not be reclaimed.
    expect(reclaimUpdate).toBeDefined()
    expect(reclaimUpdate).toMatch(ownerGuard)
    expect(releaseUpdate).toBeDefined()
    expect(releaseUpdate).toMatch(ownerGuard)

    // Ownership is company plus device, and deliberately nothing else.
    expect(repository).not.toMatch(/reclaim[\s\S]{0,2000}i\.user_uuid/)
    expect(repository).not.toContain('commit_session_epoch')
  })

  it('resolves the reconciliation owner from main-owned session metadata alone', () => {
    const worker = source('src/main/sync/invoiceUploadWorker.ts')
    const ownerAt = worker.indexOf('const reconciliationOwner = this.currentUploadOwner()')
    const reclaimAt = worker.indexOf('reclaimExpiredUploadLeases(')

    // The owner is resolved before anything is reconciled, and only from the session reader.
    expect(ownerAt).toBeGreaterThan(-1)
    expect(ownerAt).toBeLessThan(reclaimAt)
    expect(worker).toContain('reconciliation-skipped no-session-owner')
    expect(worker).toContain('this.dependencies.session.getContext()')
    // Nothing may hand the worker an owner from outside main.
    expect(worker).not.toMatch(/ipcRenderer|event\.sender|BrowserWindow/)
  })

  it('runs that recovery from the production startup path, not only from a test', () => {
    const lifecycle = source('src/main/app/appLifecycle.ts')

    // A reclaim that only a test can reach is not crash recovery. This is the production line.
    expect(lifecycle).toContain('services.invoiceUploads.requestRun()')
    expect(lifecycle.indexOf('registerIpcHandlers(services)')).toBeLessThan(
      lifecycle.indexOf('services.invoiceUploads.requestRun()')
    )
  })

  function build(): {
    readonly worker: InvoiceUploadWorker
    readonly publisher: CommercialAccessPublisher
    readonly requests: string[]
    readonly timers: { callback: () => void; delayMs: number; cancelled: boolean }[]
    readonly claimable: { value: number }
    readonly reconciledOwners: unknown[]
    readonly dispose: () => void
  } {
    const requests: string[] = []
    const reconciledOwners: unknown[] = []
    const claimable = { value: 1 }
    const timers: { callback: () => void; delayMs: number; cancelled: boolean }[] = []
    const payloadJson = JSON.stringify({ idempotency_key: INVOICE, local_invoice_uuid: INVOICE })
    const hash = payloadHash(JSON.parse(payloadJson))

    const worker = new InvoiceUploadWorker({
      syncQueue: {
        reclaimExpiredUploadLeases: (owner: unknown) => {
          reconciledOwners.push(owner)
          return []
        },
        releaseDueRetries: (owner: unknown) => {
          reconciledOwners.push(owner)
          return []
        },
        claimNextInvoiceUpload: () => {
          if (claimable.value <= 0) {
            return null
          }

          claimable.value -= 1

          return {
            localQueueUuid: '00000000-0000-4000-8000-000000000001',
            invoiceLocalUuid: INVOICE,
            payloadJson,
            payloadHash: hash,
            idempotencyKey: INVOICE,
            attemptCount: 1
          }
        },
        countForeignPendingUploads: () => 0,
        getStatus: () => ({
          state: 'idle',
          pausedReason: null,
          counts: { pending: 0, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
        })
      } as never,
      recorder: { record: () => undefined } as never,
      commercialAccess: { assertAllowed: () => undefined },
      permissions: { hasPermission: () => true },
      session: {
        getContext: () => ({ isAuthenticated: true, companyUuid: COMPANY, deviceUuid: DEVICE })
      },
      upload: async (payload) => {
        requests.push(payload)
        throw new Error('transport failed')
      },
      schedule: (callback, delayMs) => {
        const timer = { callback, delayMs, cancelled: false }
        timers.push(timer)

        return () => {
          timer.cancelled = true
        }
      }
    })

    const publisher = new CommercialAccessPublisher({
      describe: () => ({
        sell: { ...ALLOWED, action: 'sell' as const },
        sync: { ...ALLOWED, action: 'sync' as const }
      })
    })

    return {
      worker,
      publisher,
      requests,
      timers,
      claimable,
      reconciledOwners,
      dispose: subscribeInvoiceUploadTriggers({ accessPublisher: publisher, worker })
    }
  }

  it('reconciles only for the authoritative company and device tuple', async () => {
    const context = build()

    await context.worker.run()

    // Both halves of startup reconciliation received the session-derived owner, never a wildcard.
    expect(context.reconciledOwners).toHaveLength(2)
    for (const owner of context.reconciledOwners) {
      expect(owner).toEqual({ companyUuid: COMPANY, deviceUuid: DEVICE })
    }

    context.worker.shutdown()
    context.dispose()
  })

  it('leaves no live backoff timer behind when the worker is shut down', async () => {
    const context = build()

    await context.worker.run()

    // One dispatch, one scheduled retry.
    expect(context.requests).toHaveLength(1)
    expect(context.timers).toHaveLength(1)

    context.worker.shutdown()
    expect(context.timers[0]!.cancelled).toBe(true)

    // Even a timer that somehow still fires cannot restart a shut-down worker.
    context.claimable.value = 1
    context.timers[0]!.callback()
    await context.worker.run()
    expect(context.requests).toHaveLength(1)

    context.dispose()
  })

  it('keeps a disposed subscription from surviving into the next start', async () => {
    const first = build()

    await first.worker.run()
    first.worker.shutdown()
    first.dispose()

    const second = build()

    // The restarted worker owns exactly one live subscription, so one publication is one drain.
    first.claimable.value = 1
    first.publisher.publishCurrent()
    second.publisher.publishCurrent()
    await second.worker.run()
    second.worker.shutdown()

    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)

    second.dispose()
  })
})
