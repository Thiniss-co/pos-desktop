import { describe, expect, it, vi } from 'vitest'
import { createPublicError } from '../http/apiError'
import { payloadHash } from '../services/localSale.fingerprint'
import { InvoiceUploadWorker, type InvoiceUploadWorkerDependencies } from './invoiceUploadWorker'
import type { ClaimedInvoiceUpload } from '../repositories/syncQueue.repository'
import type { InvoiceUploadOutcome } from './invoiceUploadOutcome'
import type { InvoiceUploadAccepted } from './invoiceUpload.client'

const payload = { idempotency_key: 'invoice-1', items: [] }
const payloadJson = JSON.stringify(payload)

function claim(overrides: Partial<ClaimedInvoiceUpload> = {}): ClaimedInvoiceUpload {
  return {
    localQueueUuid: 'queue-1',
    invoiceLocalUuid: 'invoice-1',
    payloadJson,
    payloadHash: payloadHash(payload),
    idempotencyKey: 'invoice-1',
    attemptCount: 1,
    ...overrides
  }
}

function accepted(kind: 'created' | 'duplicate' = 'created'): InvoiceUploadAccepted {
  return {
    kind,
    invoice: {
      id: 'server-uuid',
      server_number: 'POS-20260902-000001'
    } as InvoiceUploadAccepted['invoice']
  }
}

interface Harness {
  readonly worker: InvoiceUploadWorker
  readonly recorded: { claimed: ClaimedInvoiceUpload; outcome: InvoiceUploadOutcome }[]
  readonly upload: ReturnType<typeof vi.fn>
  readonly claims: ReturnType<typeof vi.fn>
  readonly logs: string[]
}

function harness(
  options: {
    readonly queue?: ClaimedInvoiceUpload[]
    readonly upload?: () => Promise<InvoiceUploadAccepted>
    readonly assertAllowed?: () => void
    readonly hasPermission?: boolean
    readonly authenticated?: boolean
  } = {}
): Harness {
  const pending = [...(options.queue ?? [claim()])]
  const recorded: { claimed: ClaimedInvoiceUpload; outcome: InvoiceUploadOutcome }[] = []
  const logs: string[] = []
  const claims = vi.fn(() => pending.shift() ?? null)
  const upload = vi.fn(options.upload ?? (async () => accepted()))

  const dependencies: InvoiceUploadWorkerDependencies = {
    syncQueue: {
      reclaimExpiredUploadLeases: vi.fn(() => []),
      releaseDueRetries: vi.fn(() => []),
      claimNextInvoiceUpload: claims,
      countForeignPendingUploads: vi.fn(() => 0),
      getStatus: vi.fn((pausedReason: string | null = null) => ({
        state: pausedReason === null ? ('idle' as const) : ('paused' as const),
        pausedReason,
        counts: { pending: 0, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
      }))
    } as unknown as InvoiceUploadWorkerDependencies['syncQueue'],
    recorder: {
      record: (claimed: ClaimedInvoiceUpload, outcome: InvoiceUploadOutcome) => {
        recorded.push({ claimed, outcome })
      }
    } as unknown as InvoiceUploadWorkerDependencies['recorder'],
    commercialAccess: {
      assertAllowed:
        options.assertAllowed ??
        ((): void => {
          /* allowed */
        })
    },
    permissions: { hasPermission: () => options.hasPermission ?? true },
    session: {
      getContext: () => ({
        isAuthenticated: options.authenticated ?? true,
        companyUuid: 'company-1',
        deviceUuid: 'device-1'
      })
    },
    upload,
    schedule: () => (): void => {
      /* timers are not exercised here */
    },
    log: (line) => logs.push(line)
  }

  return { worker: new InvoiceUploadWorker(dependencies), recorded, upload, claims, logs }
}

describe('InvoiceUploadWorker', () => {
  it('uploads a queued invoice and records it as synced', async () => {
    const { worker, recorded, upload } = harness()

    const summary = await worker.run()

    expect(upload).toHaveBeenCalledWith(payloadJson)
    expect(summary).toMatchObject({ uploaded: 1, duplicates: 0, failed: 0, pausedReason: null })
    expect(recorded[0]?.outcome).toMatchObject({
      kind: 'synced',
      remoteUuid: 'server-uuid',
      serverNumber: 'POS-20260902-000001'
    })
  })

  it('records a duplicate answer as synced too', async () => {
    const { worker, recorded } = harness({ upload: async () => accepted('duplicate') })

    const summary = await worker.run()

    expect(summary).toMatchObject({ uploaded: 0, duplicates: 1 })
    expect(recorded[0]?.outcome.kind).toBe('synced')
  })

  it('drains every due invoice in one run', async () => {
    const { worker, upload } = harness({
      queue: [
        claim({ localQueueUuid: 'q1' }),
        claim({ localQueueUuid: 'q2' }),
        claim({ localQueueUuid: 'q3' })
      ]
    })

    const summary = await worker.run()

    expect(upload).toHaveBeenCalledTimes(3)
    expect(summary.uploaded).toBe(3)
  })

  describe('authorization', () => {
    it('dispatches nothing when sync access is denied, and reports the reason', async () => {
      const { worker, upload } = harness({
        assertAllowed: () => {
          throw createPublicError('authorization', 'Licence denied', false, {
            backendCode: 'COMMERCIAL_ACCESS_LICENSE_DENIED'
          })
        }
      })

      const summary = await worker.run()

      expect(upload).not.toHaveBeenCalled()
      expect(summary.pausedReason).toBe('license-denied')
      expect(worker.getStatus()).toMatchObject({ state: 'paused', pausedReason: 'license-denied' })
    })

    it('dispatches nothing without pos.invoice.upload', async () => {
      const { worker, upload } = harness({ hasPermission: false })

      const summary = await worker.run()

      expect(upload).not.toHaveBeenCalled()
      expect(summary.pausedReason).toBe('permission-denied')
    })

    it('dispatches nothing without an authenticated session', async () => {
      const { worker, upload } = harness({ authenticated: false })

      expect((await worker.run()).pausedReason).toBe('session-invalid')
      expect(upload).not.toHaveBeenCalled()
    })

    it('re-evaluates authorization before every dispatch, not once per run', async () => {
      // Authority is revoked after the first invoice. The second must never go out.
      let calls = 0
      const { worker, upload } = harness({
        queue: [claim({ localQueueUuid: 'q1' }), claim({ localQueueUuid: 'q2' })],
        assertAllowed: () => {
          calls += 1

          if (calls > 1) {
            throw createPublicError('authorization', 'Revoked', false, {
              backendCode: 'COMMERCIAL_ACCESS_LICENSE_DENIED'
            })
          }
        }
      })

      const summary = await worker.run()

      expect(upload).toHaveBeenCalledTimes(1)
      expect(summary).toMatchObject({ uploaded: 1, pausedReason: 'license-denied' })
    })

    it('clears the pause once authority returns', async () => {
      let allowed = false
      const { worker } = harness({
        assertAllowed: () => {
          if (!allowed) {
            throw createPublicError('authorization', 'Denied', false, {
              backendCode: 'COMMERCIAL_ACCESS_LICENSE_DENIED'
            })
          }
        }
      })

      expect((await worker.run()).pausedReason).toBe('license-denied')
      allowed = true
      expect((await worker.run()).pausedReason).toBeNull()
      expect(worker.getStatus().state).toBe('idle')
    })
  })

  describe('failure handling', () => {
    it('stops the whole run on a server-side denial', async () => {
      const { worker, recorded, upload } = harness({
        queue: [claim({ localQueueUuid: 'q1' }), claim({ localQueueUuid: 'q2' })],
        upload: async () => {
          throw createPublicError('authorization', 'Sync is not permitted.', false, {
            backendCode: 'FORBIDDEN'
          })
        }
      })

      const summary = await worker.run()

      expect(upload).toHaveBeenCalledTimes(1)
      expect(summary).toMatchObject({ failed: 1, pausedReason: 'license-denied' })
      // The item is released, never marked terminal — it did nothing wrong.
      expect(recorded[0]?.outcome).toMatchObject({ kind: 'retryable', retryDelayMs: 0 })
    })

    it('keeps draining after a terminal rejection of one invoice', async () => {
      let call = 0
      const { worker, recorded, upload } = harness({
        queue: [claim({ localQueueUuid: 'q1' }), claim({ localQueueUuid: 'q2' })],
        upload: async () => {
          call += 1

          if (call === 1) {
            throw createPublicError('rejected', 'Stale catalog', false, {
              backendCode: 'DESKTOP_CATALOG_REVISION_INVALID'
            })
          }

          return accepted()
        }
      })

      const summary = await worker.run()

      expect(upload).toHaveBeenCalledTimes(2)
      expect(summary).toMatchObject({ uploaded: 1, failed: 1, pausedReason: null })
      expect(recorded[0]?.outcome.kind).toBe('rejected')
    })

    it('records a conflict without pausing', async () => {
      const { worker, recorded } = harness({
        upload: async () => {
          throw createPublicError('conflict', 'Key reused with a different payload.', false, {
            backendCode: 'IDEMPOTENCY_CONFLICT'
          })
        }
      })

      const summary = await worker.run()

      expect(summary.pausedReason).toBeNull()
      expect(recorded[0]?.outcome.kind).toBe('conflict')
    })

    it('treats a thrown non-PublicAppError as retryable, never as a rejection', async () => {
      const { worker, recorded } = harness({
        upload: async () => {
          throw new Error('socket exploded')
        }
      })

      await worker.run()

      expect(recorded[0]?.outcome.kind).toBe('retryable')
    })
  })

  describe('payload integrity', () => {
    it('never dispatches a payload whose hash no longer matches', async () => {
      const { worker, recorded, upload, logs } = harness({
        queue: [claim({ payloadHash: 'b'.repeat(64) })]
      })

      const summary = await worker.run()

      expect(upload).not.toHaveBeenCalled()
      expect(summary.failed).toBe(1)
      expect(recorded[0]?.outcome).toMatchObject({
        kind: 'retryable',
        errorCode: 'payload_integrity_mismatch'
      })
      expect(logs.join(' ')).toContain('payload-integrity-mismatch')
    })

    it('holds an unparseable payload instead of rejecting the sale', async () => {
      const { worker, recorded, upload } = harness({
        queue: [claim({ payloadJson: '{ not json' })]
      })

      await worker.run()

      expect(upload).not.toHaveBeenCalled()
      expect(recorded[0]?.outcome.kind).toBe('retryable')
    })
  })

  describe('single flight', () => {
    it('never dispatches two drains concurrently', async () => {
      let inFlight = 0
      let maximum = 0
      const { worker, upload } = harness({
        queue: [claim({ localQueueUuid: 'q1' }), claim({ localQueueUuid: 'q2' })],
        upload: async () => {
          inFlight += 1
          maximum = Math.max(maximum, inFlight)
          await Promise.resolve()
          inFlight -= 1

          return accepted()
        }
      })

      await Promise.all([worker.run(), worker.run(), worker.run()])

      expect(maximum).toBe(1)
      expect(upload).toHaveBeenCalledTimes(2)
    })
  })

  it('stops dispatching after shutdown', async () => {
    const { worker, upload } = harness({
      queue: [claim({ localQueueUuid: 'q1' }), claim({ localQueueUuid: 'q2' })]
    })

    worker.shutdown()
    await worker.run()

    expect(upload).not.toHaveBeenCalled()
  })
})
