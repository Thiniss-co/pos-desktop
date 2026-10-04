import { describe, expect, it } from 'vitest'
import type { PublicAppError } from '@shared/contracts/api.contract'
import { createPublicError, withRetryAfterDetails } from '../http/apiError'
import { payloadHash } from '../services/localSale.fingerprint'
import type {
  ClaimedInvoiceUpload,
  InvoiceUploadCandidate
} from '../repositories/syncQueue.repository'
import type { UploadDependencyDecision } from '../repositories/uploadDependency.repository'
import type { InvoiceUploadAccepted } from './invoiceUpload.client'
import type { InvoiceUploadOutcome } from './invoiceUploadOutcome'
import { mapUploadFailure } from './invoiceUploadMapping'
import {
  InvoiceUploadWorker,
  MAX_WAKE_MS,
  V3_SEND_MARGIN_MS,
  type InvoiceUploadWorkerDependencies
} from './invoiceUploadWorker'
import { ServerTimeEstimator } from './serverTimeEstimator'

/**
 * Rev 4 §10.2 / §10.5 / §10.5a: the upload worker's single timer is recomputed from EVERY future
 * deadline after every drain; a categorical pause arms nothing; a v3 invoice is sent only once the
 * server-time lower bound says the server will accept its `sold_at`; skipped rows stay unchanged.
 */

const T0 = Date.parse('2026-09-30T12:00:00.000Z')

interface Row {
  readonly id: string
  readonly payloadJson: string
  state: 'pending' | 'uploading' | 'retryable_error' | 'synced'
  nextAttemptAt: number | null
  attemptCount: number
}

function row(id: string, payload: Record<string, unknown> = {}): Row {
  return {
    id,
    payloadJson: JSON.stringify({ idempotency_key: id, ...payload }),
    state: 'pending',
    nextAttemptAt: null,
    attemptCount: 0
  }
}

function accepted(): InvoiceUploadAccepted {
  return {
    kind: 'created',
    invoice: { id: 'server', server_number: 'POS-1' } as InvoiceUploadAccepted['invoice']
  }
}

function transient(retryAfterSeconds: number): PublicAppError {
  return withRetryAfterDetails(
    createPublicError('transport', 'Service unavailable', true, { httpStatus: 503 }),
    503,
    retryAfterSeconds
  )
}

interface Timer {
  readonly at: number
  readonly delay: number
  readonly callback: () => void
  cancelled: boolean
}

interface World {
  readonly worker: InvoiceUploadWorker
  readonly sent: string[]
  readonly rows: Row[]
  readonly claimsConsidered: string[]
  readonly drains: () => number
  readonly live: () => Timer[]
  readonly advance: (ms: number) => void
  readonly fire: () => Promise<void>
}

/** A stateful in-memory queue with the repository's semantics, driven by a controlled clock. */
function world(
  rows: Row[],
  options: {
    readonly failures?: Record<string, number[]>
    readonly allowed?: () => boolean
    readonly timeGate?: InvoiceUploadWorkerDependencies['timeGate']
    readonly dependency?: (invoice: string) => UploadDependencyDecision
  } = {}
): World {
  let now = T0
  const timers: Timer[] = []
  const sent: string[] = []
  const claimsConsidered: string[] = []
  let drains = 0
  const failures = { ...(options.failures ?? {}) }

  const worker = new InvoiceUploadWorker({
    syncQueue: {
      reclaimExpiredUploadLeases: () => [],
      releaseDueRetries: () => {
        drains += 1
        for (const r of rows) {
          if (r.state === 'retryable_error' && (r.nextAttemptAt ?? 0) <= now) {
            r.state = 'pending'
          }
        }
        return []
      },
      claimNextInvoiceUpload: (
        _owner: unknown,
        _nowIso: string,
        accept: (candidate: InvoiceUploadCandidate) => boolean
      ): ClaimedInvoiceUpload | null => {
        const candidate = rows.find((r) => {
          if (r.state !== 'pending') return false
          claimsConsidered.push(r.id)
          return accept({
            localQueueUuid: r.id,
            invoiceLocalUuid: r.id,
            payloadJson: r.payloadJson
          })
        })
        if (!candidate) return null
        candidate.state = 'uploading'
        candidate.attemptCount += 1
        return {
          localQueueUuid: candidate.id,
          invoiceLocalUuid: candidate.id,
          payloadJson: candidate.payloadJson,
          payloadHash: payloadHash(JSON.parse(candidate.payloadJson)),
          idempotencyKey: candidate.id,
          attemptCount: candidate.attemptCount
        }
      },
      nextRetryDeadline: () => {
        const future = rows
          .filter((r) => r.state === 'retryable_error' && r.nextAttemptAt !== null)
          .map((r) => r.nextAttemptAt as number)
          .filter((at) => at > now)
        return future.length === 0 ? null : new Date(Math.min(...future)).toISOString()
      },
      countForeignPendingUploads: () => 0,
      getStatus: () => ({
        state: 'idle',
        pausedReason: null,
        counts: { pending: 0, uploading: 0, retryableError: 0, conflict: 0, rejected: 0 }
      })
    } as never,
    recorder: {
      record: (claimed: ClaimedInvoiceUpload, outcome: InvoiceUploadOutcome) => {
        const r = rows.find((candidate) => candidate.id === claimed.localQueueUuid) as Row
        if (outcome.kind === 'synced') {
          r.state = 'synced'
        } else if (outcome.kind === 'retryable') {
          r.state = 'retryable_error'
          r.nextAttemptAt = now + outcome.retryDelayMs
        }
      }
    } as never,
    commercialAccess: {
      assertAllowed: () => {
        if (options.allowed && !options.allowed()) {
          throw createPublicError('authorization', 'denied', false, {
            backendCode: 'COMMERCIAL_ACCESS_LICENSE_DENIED'
          })
        }
      }
    },
    permissions: { hasPermission: () => true },
    session: {
      getContext: () => ({ isAuthenticated: true, companyUuid: 'c', deviceUuid: 'd' })
    },
    upload: async (payload) => {
      const id = (JSON.parse(payload) as { idempotency_key: string }).idempotency_key
      sent.push(id)
      const queue = failures[id]
      if (queue && queue.length > 0) {
        throw transient(queue.shift() as number)
      }
      return accepted()
    },
    now: () => new Date(now),
    schedule: (callback, delay) => {
      const timer = { at: now + delay, delay, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    ...(options.timeGate ? { timeGate: options.timeGate } : {}),
    ...(options.dependency ? { uploadDependencies: { evaluate: options.dependency } } : {})
  })

  const live = (): Timer[] => timers.filter((timer) => !timer.cancelled)

  return {
    worker,
    sent,
    rows,
    claimsConsidered,
    drains: () => drains,
    live,
    advance: (ms: number) => {
      now += ms
    },
    /** Fire the single live timer (advancing the clock to it) and wait for the drain. */
    async fire(): Promise<void> {
      const armed = live()
      expect(armed).toHaveLength(1)
      const timer = armed[0]
      timer.cancelled = true
      now = Math.max(now, timer.at)
      timer.callback() // the worker's own wake: requestRun()
      // Wait for that drain (and any rerun it scheduled) to settle.
      for (let turn = 0; turn < 20; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  }
}

describe('upload wake scheduling (Rev 4 §10.5)', () => {
  it('A waits 300 s and B 5 s: after B runs, the timer is re-armed ~295 s for A', async () => {
    const w = world([row('A'), row('B')], { failures: { A: [300], B: [5] } })

    await w.worker.run()
    expect(w.sent).toEqual(['A', 'B'])
    expect(w.live().map((timer) => timer.delay)).toEqual([5_000])

    await w.fire()
    expect(w.sent).toEqual(['A', 'B', 'B'])
    expect(w.rows.find((r) => r.id === 'B')?.state).toBe('synced')
    const rearmed = w.live()
    expect(rearmed).toHaveLength(1)
    expect(rearmed[0].delay).toBe(295_000)

    await w.fire()
    expect(w.sent).toEqual(['A', 'B', 'B', 'A'])
    expect(w.rows.every((r) => r.state === 'synced')).toBe(true)
    expect(w.live()).toHaveLength(0)
  })

  it('never arms a timer further than five minutes; it recomputes when it fires', async () => {
    const w = world([row('A')], { failures: { A: [3_600] } })
    await w.worker.run()
    expect(w.live()[0].delay).toBe(MAX_WAKE_MS)
    await w.fire()
    expect(w.sent).toEqual(['A'])
    // 55 minutes remain: still capped, recomputed again at the next wake — never sent early.
    expect(w.live()[0].delay).toBe(MAX_WAKE_MS)
    for (let wake = 0; wake < 10; wake += 1) {
      await w.fire()
    }
    expect(w.sent).toEqual(['A'])
    await w.fire()
    expect(w.sent).toEqual(['A', 'A'])
    expect(w.live()).toHaveLength(0)
  })

  it('a categorical pause with a retry already due arms no timer and does not spin', async () => {
    let allowed = false
    const w = world([row('A')], { allowed: () => allowed })
    w.rows[0].state = 'retryable_error'
    w.rows[0].nextAttemptAt = T0 - 1_000 // already due

    await w.worker.run()
    expect(w.sent).toEqual([])
    expect(w.live()).toHaveLength(0)
    const drainsWhilePaused = w.drains()

    w.advance(60_000)
    expect(w.live()).toHaveLength(0)
    expect(w.drains()).toBe(drainsWhilePaused)

    // The access event (what `subscribeInvoiceUploadTriggers` delivers) resumes it.
    allowed = true
    await w.worker.run()
    expect(w.sent).toEqual(['A'])
    expect(w.live()).toHaveLength(0)
  })

  it('honours Retry-After over a shorter backoff', () => {
    const disposition = mapUploadFailure(transient(120), 1, () => 0.5)
    expect(disposition.kind).toBe('outcome')
    expect(disposition.outcome).toMatchObject({ kind: 'retryable', retryDelayMs: 120_000 })
  })
})

describe('v3 send gate (Rev 4 §10.2)', () => {
  const soldAt = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()

  it('defers a v3 invoice sold ahead of the server estimate, unchanged, then sends it once', async () => {
    let lowerBound = T0
    const w = world(
      [row('V3', { client_contract_version: 3, sold_at: soldAt(5 * 60_000) }), row('V2')],
      { timeGate: { lowerBound: () => lowerBound, requestSample: () => undefined } }
    )

    await w.worker.run()
    expect(w.sent).toEqual(['V2'])
    const deferred = w.rows[0]
    expect(deferred).toMatchObject({ state: 'pending', attemptCount: 0, nextAttemptAt: null })
    expect(w.live()[0].delay).toBe(5 * 60_000 - V3_SEND_MARGIN_MS)

    lowerBound = T0 + 5 * 60_000 - V3_SEND_MARGIN_MS
    await w.fire()
    expect(w.sent).toEqual(['V2', 'V3'])
    expect(w.live()).toHaveLength(0)
  })

  it('with no usable sample a v3 invoice is not sent; one probe is requested, with backoff', async () => {
    let requested = 0
    const w = world([row('V3', { client_contract_version: 3, sold_at: soldAt(0) })], {
      timeGate: {
        lowerBound: () => null,
        requestSample: () => {
          requested += 1
        }
      }
    })

    await w.worker.run()
    expect(w.sent).toEqual([])
    expect(requested).toBe(1)
    expect(w.live()[0].delay).toBe(30_000)
    await w.fire()
    expect(requested).toBe(2)
    expect(w.live()[0].delay).toBe(60_000)
    expect(w.sent).toEqual([])
  })

  it('a v2 invoice is never gated', async () => {
    const w = world([row('V2', { client_contract_version: 2, sold_at: soldAt(3_600_000) })], {
      timeGate: { lowerBound: () => null, requestSample: () => undefined }
    })
    await w.worker.run()
    expect(w.sent).toEqual(['V2'])
  })
})

describe('dependency holds in the drain (Rev 4 §10.3)', () => {
  it('a held dependent is skipped, unrelated invoices proceed, and no timer is armed for it', async () => {
    let predecessorSynced = false
    const w = world([row('P'), row('D'), row('U')], {
      failures: { P: [30] },
      dependency: (invoice) =>
        invoice === 'D' && !predecessorSynced
          ? { eligible: false, block: 'predecessor-pending', predecessor: null }
          : { eligible: true }
    })

    await w.worker.run()
    expect(w.sent).toEqual(['P', 'U'])
    expect(w.rows.find((r) => r.id === 'D')).toMatchObject({ state: 'pending', attemptCount: 0 })
    // Only P's retry deadline is armed; the held dependent contributes nothing.
    expect(w.live().map((timer) => timer.delay)).toEqual([30_000])

    predecessorSynced = true
    await w.fire()
    expect(w.sent).toEqual(['P', 'U', 'P', 'D'])
  })
})

describe('ServerTimeEstimator (Rev 4 §10.1)', () => {
  it('bounds server time from a second-precision sample and monotonic age', () => {
    let mono = 1_000
    const estimator = new ServerTimeEstimator({ monotonicNow: () => mono })
    expect(estimator.lowerBound()).toBeNull()

    expect(
      estimator.offer({
        serverTime: 'Wed, 30 Sep 2026 12:00:00 GMT',
        sentAtMono: 800,
        receivedAtMono: 1_000
      })
    ).toBe(true)
    expect(estimator.lowerBound()).toBe(T0)

    mono += 10_000
    expect(estimator.lowerBound()).toBeCloseTo(T0 + 10_000 - 1, 5)
  })

  it('refuses a slow round trip, an unparseable time and an out-of-order sample', () => {
    const estimator = new ServerTimeEstimator({ monotonicNow: () => 10_000 })
    expect(
      estimator.offer({ serverTime: '2026-09-30T12:00:00Z', sentAtMono: 0, receivedAtMono: 5_001 })
    ).toBe(false)
    expect(estimator.offer({ serverTime: 'nope', sentAtMono: 0, receivedAtMono: 10 })).toBe(false)
    expect(
      estimator.offer({ serverTime: '2026-09-30T12:00:00Z', sentAtMono: 90, receivedAtMono: 100 })
    ).toBe(true)
    expect(
      estimator.offer({ serverTime: '2026-09-30T13:00:00Z', sentAtMono: 40, receivedAtMono: 50 })
    ).toBe(false)
  })

  it('a sample older than six hours, or invalidated by suspend/resume, is unusable', () => {
    let mono = 0
    const estimator = new ServerTimeEstimator({ monotonicNow: () => mono })
    estimator.offer({ serverTime: '2026-09-30T12:00:00Z', sentAtMono: 0, receivedAtMono: 0 })
    mono = 6 * 3_600_000 + 1
    expect(estimator.lowerBound()).toBeNull()

    estimator.offer({ serverTime: '2026-09-30T18:00:00Z', sentAtMono: mono, receivedAtMono: mono })
    expect(estimator.lowerBound()).not.toBeNull()
    estimator.invalidate()
    expect(estimator.lowerBound()).toBeNull()
  })

  it('a wall-clock jump has no effect on the bound', () => {
    const realNow = Date.now
    const estimator = new ServerTimeEstimator({ monotonicNow: () => 1_000 })
    estimator.offer({
      serverTime: '2026-09-30T12:00:00Z',
      sentAtMono: 1_000,
      receivedAtMono: 1_000
    })
    Date.now = () => realNow() + 3_600_000
    try {
      expect(estimator.lowerBound()).toBe(T0)
    } finally {
      Date.now = realNow
    }
  })
})
