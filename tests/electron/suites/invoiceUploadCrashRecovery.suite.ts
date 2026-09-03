import { deepEqual, equal, notEqual, ok } from 'node:assert/strict'
import { resolve } from 'node:path'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import { uploadInvoice } from '../../../src/main/sync/invoiceUpload.client'
import { isUploadLeaseExpired } from '../../../src/main/sync/syncPolicy'
import type { InvoiceUploadWorkerSessionReader } from '../../../src/main/sync/invoiceUploadWorker'
import {
  SYNC_QUEUE_TRANSITIONS,
  isSyncQueueTransitionAllowed
} from '@shared/constants/syncQueueStates'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import { failingDatabase } from '../support/failingDatabase'
import { startFreshProcess, type FreshProcessHandle } from '../support/freshProcess'
import {
  liveUploadBackendAvailable,
  liveUploadFixture,
  readScenarioEffects,
  type BackendScenarioEffects
} from '../support/liveUploadBackend'
import { createUploadTransportSpy, type UploadTransportSpy } from '../support/uploadTransportSpy'
import {
  buildUploadWorker,
  crashMarkerPath,
  readInvoiceRow,
  readLocalCounts,
  readQueueRow,
  recordEvidence,
  seedQueuedInvoice,
  testUuid,
  uploadIdentity,
  type CrashStage,
  type SeededInvoice
} from '../support/uploadCrash'

/**
 * CP-3G-6 — crash recovery, proven with real process death.
 *
 * Every crash here is a real `SIGKILL` delivered by the test to a **separate** Electron process
 * that is parked at a chosen boundary of one dispatch. Nothing is simulated by throwing inside the
 * running process: the killed worker runs no `catch`, no `finally` and no cleanup, and everything
 * asserted afterwards is read back from the SQLite file by processes that were not alive when it
 * died.
 *
 * The production transition path is the thing under test:
 * `uploading -> retryable_error (upload_lease_expired) -> pending -> uploading -> synced`.
 * A direct `uploading -> pending` is forbidden by the frozen state machine and never occurs.
 */

const WORKER_SOURCE = resolve(process.cwd(), 'tests/electron/support/uploadCrashWorker.ts')
/** Refused on connect, so a hermetic dispatch is a real outbound attempt with no server behind it. */
const UNREACHABLE_ORIGIN = 'http://127.0.0.1:1'
const UPLOAD_PATH = '/api/v1/desktop/invoices/upload'
const LEASE_DURATION_MS = 60_000
const HERMETIC_COMPANY = testUuid('11')
const HERMETIC_DEVICE = testUuid('33')
const HERMETIC_SHIFT = testUuid('55')
/** CP-3G-5 owns fixture payloads 0-14; CP-3G-6 starts after them and needs a larger mint. */
const LIVE_PAYLOAD_BASE = 16

function liveSkipReason(): string | false {
  if (!liveUploadBackendAvailable()) {
    return 'no live CP-3G-5 backend provided'
  }

  const fixture = liveUploadFixture()

  if (fixture === null || fixture.payloads.length <= LIVE_PAYLOAD_BASE + 4) {
    return 'live backend was minted without the CP-3G-6 payload budget (CP3G5_PAYLOADS=32)'
  }

  return false
}

interface CrashContext {
  readonly sandbox: DatabaseSandbox
  readonly database: SqliteDatabase
  readonly repositories: RealRepositories
  readonly spy: UploadTransportSpy
  readonly owner: { readonly companyUuid: string; readonly deviceUuid: string }
  seed(index: number, options?: { readonly breakPayloadHash?: boolean }): SeededInvoice
  seedFor(
    index: number,
    owner: { readonly companyUuid: string; readonly deviceUuid: string }
  ): SeededInvoice
  /** The production worker over the production client, dispatching to the unreachable origin. */
  hermeticWorker(
    nowOffsetMs?: number,
    overrides?: {
      readonly owner?: { readonly companyUuid: string; readonly deviceUuid: string }
      readonly session?: InvoiceUploadWorkerSessionReader
    }
  ): ReturnType<typeof buildUploadWorker>
  crashEnvironment(seeded: SeededInvoice): Record<string, string>
  close(): void
}

function createContext(sandbox: DatabaseSandbox, live: boolean): CrashContext {
  const fixture = live ? liveUploadFixture() : null
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const spy = createUploadTransportSpy()
  const owner = {
    companyUuid: fixture?.companyUuid ?? HERMETIC_COMPANY,
    deviceUuid: fixture?.deviceUuid ?? HERMETIC_DEVICE
  }
  const shiftUuid = fixture?.shiftUuid ?? HERMETIC_SHIFT
  let counter = 0

  const payloadFor = (index: number): Record<string, unknown> =>
    fixture ? (fixture.payloads[index] as Record<string, unknown>) : hermeticPayload(index)

  const seedWith = (
    index: number,
    seedOwner: { readonly companyUuid: string; readonly deviceUuid: string },
    breakPayloadHash: boolean
  ): SeededInvoice => {
    counter += 1

    return seedQueuedInvoice(database, repositories, {
      n: String(counter),
      payload: payloadFor(index),
      companyUuid: seedOwner.companyUuid,
      deviceUuid: seedOwner.deviceUuid,
      shiftUuid,
      breakPayloadHash
    })
  }

  return {
    sandbox,
    database,
    repositories,
    spy,
    owner,
    seed: (index, options = {}) => seedWith(index, owner, options.breakPayloadHash === true),
    seedFor: (index, seedOwner) => seedWith(index, seedOwner, false),
    hermeticWorker(nowOffsetMs = 0, overrides = {}) {
      const apiClient = new DesktopApiClient({
        apiOrigin: new URL(UNREACHABLE_ORIGIN),
        getAccessToken: () => 'hermetic-no-server',
        getDeviceUuid: () => owner.deviceUuid,
        fetchImplementation: spy.fetchImplementation,
        timeoutMs: 2_000
      })

      return buildUploadWorker({
        database,
        repositories,
        owner: overrides.owner ?? owner,
        upload: (payloadJson) => uploadInvoice(apiClient, payloadJson),
        nowOffsetMs,
        ...(overrides.session === undefined ? {} : { session: overrides.session })
      })
    },
    crashEnvironment(seeded) {
      return {
        POS_CRASH_MARKER_DIR: sandbox.root,
        POS_CRASH_QUEUE_UUID: seeded.queueUuid,
        POS_CRASH_INVOICE_UUID: seeded.invoiceUuid,
        POS_CRASH_COMPANY_UUID: owner.companyUuid,
        POS_CRASH_DEVICE_UUID: owner.deviceUuid
      }
    },
    close() {
      closeDatabase(database)
    }
  }
}

/** A committed v2 body with the same shape the live seeder mints, for the hermetic arms. */
function hermeticPayload(index: number): Record<string, unknown> {
  const invoiceUuid = testUuid(`9${index}`)

  return {
    idempotency_key: invoiceUuid,
    local_invoice_uuid: invoiceUuid,
    catalog_revision: 'c'.repeat(64),
    offline_number: `CP3G6-H${index}`,
    sold_at: '2026-09-03T10:00:00+00:00',
    sold_while_offline: true,
    currency: 'USD',
    tax_mode: 'none',
    client_contract_version: 2,
    shift_uuid: HERMETIC_SHIFT,
    items: [
      {
        product_uuid: testUuid(`6${index}`),
        quantity: '1.000',
        unit_price_amount: 1000,
        price_revision: 'p'.repeat(64),
        tax_rate_basis_points: 0,
        tax_revision: 't'.repeat(64),
        allocations: [
          {
            allocation_uuid: testUuid(`4${index}`),
            rights_generation: 1,
            consumption_sequence: 1,
            local_consumption_uuid: testUuid(`5${index}`),
            quantity_milli: 1000
          }
        ]
      }
    ],
    payments: [{ type: 'cash', amount: 1000 }]
  }
}

/**
 * Runs one dispatch in a separate process, waits for it to park at `stage`, lets the caller verify
 * the world while it is still parked, then kills it with a real `SIGKILL`.
 */
async function crashAt(
  context: CrashContext,
  stage: CrashStage,
  seeded: SeededInvoice,
  beforeKill: (marker: Record<string, unknown>) => void | Promise<void> = () => undefined
): Promise<Record<string, unknown>> {
  const handle: FreshProcessHandle = startFreshProcess(context.sandbox, WORKER_SOURCE, stage, {
    POS_CRASH_COMMAND: 'crash',
    POS_CRASH_STAGE: stage,
    ...context.crashEnvironment(seeded)
  })
  const marker = await handle.waitForMarker(crashMarkerPath(context.sandbox.root))

  let boundaryFailure: unknown = null

  try {
    await beforeKill(marker)
  } catch (error) {
    // The kill still happens: a failed expectation must not leave a parked process behind.
    boundaryFailure = error
  }

  handle.kill('SIGKILL')

  const outcome = await handle.wait()

  if (boundaryFailure !== null) {
    throw boundaryFailure
  }

  // A real signal, delivered from outside, to the process that held the SQLite handle.
  equal(outcome.signal, 'SIGKILL', 'the worker must be terminated by a real SIGKILL')
  ok(outcome.killedBySignal)
  equal(outcome.result, null, 'a killed worker must never report a completed run')

  return marker
}

/**
 * Runs one non-crash command in yet another Electron process and returns what that process found.
 *
 * Every post-crash claim in this suite is read back this way: the verifying process was not alive
 * when the worker died, opens the database file itself, and reports only what the file says.
 */
async function runFreshCommand(
  context: CrashContext,
  seeded: SeededInvoice,
  command: 'inspect' | 'reclaim-only' | 'drain',
  environment: Readonly<Record<string, string>> = {}
): Promise<Record<string, unknown>> {
  const handle: FreshProcessHandle = startFreshProcess(context.sandbox, WORKER_SOURCE, command, {
    POS_CRASH_COMMAND: command,
    ...context.crashEnvironment(seeded),
    ...environment
  })
  const outcome = await handle.wait()

  ok(outcome.result !== null, `fresh process produced no result: ${outcome.stderr.slice(-2000)}`)
  notEqual(outcome.result.outcome, 'worker-error', JSON.stringify(outcome.result))
  equal(outcome.status, 0, outcome.stderr.slice(-2000))

  return outcome.result
}

interface QueueShape {
  readonly state: string
  readonly attempt_count: number
  readonly upload_lease_at: string | null
  readonly last_error_code: string | null
  readonly next_attempt_at: string | null
  readonly payload_json: string
  readonly payload_hash: string
  readonly idempotency_key: string
}

function queueShape(row: Record<string, unknown>): QueueShape {
  return row as unknown as QueueShape
}

/** Every queue row in the database, ordered, for a byte-level "nothing changed" comparison. */
function allQueueRows(database: SqliteDatabase): readonly Record<string, unknown>[] {
  return database.prepare('SELECT * FROM sync_queue ORDER BY local_queue_uuid ASC').all() as Record<
    string,
    unknown
  >[]
}

function allInvoiceRows(database: SqliteDatabase): readonly Record<string, unknown>[] {
  return database.prepare('SELECT * FROM local_invoices ORDER BY local_uuid ASC').all() as Record<
    string,
    unknown
  >[]
}

/**
 * Records a failure into the evidence ledger before rethrowing it.
 *
 * The authorized live wrapper captures the Electron suite's output instead of forwarding it, which
 * is part of its redaction boundary. Without this, a failing live case reports nothing a reader can
 * act on. Only the assertion's own message is written, truncated; no header value, credential or
 * request body ever reaches an assertion message in this suite.
 */
async function recorded(
  name: string,
  context: CrashContext,
  callback: (context: CrashContext) => Promise<void>
): Promise<void> {
  try {
    await callback(context)
  } catch (error) {
    recordEvidence({
      case: name,
      failed: true,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 600)
    })

    throw error
  } finally {
    context.close()
  }
}

function hermeticTest(name: string, callback: (context: CrashContext) => Promise<void>): void {
  databaseTest(name, async (sandbox) => {
    await recorded(name, createContext(sandbox, false), callback)
  })
}

function liveTest(name: string, callback: (context: CrashContext) => Promise<void>): void {
  databaseTest(
    name,
    async (sandbox) => {
      await recorded(name, createContext(sandbox, true), callback)
    },
    { skip: liveSkipReason() }
  )
}

// ---------------------------------------------------------------------------------------------
// CP-3G-6E — the claim boundary, and the shape a crash must leave behind
// ---------------------------------------------------------------------------------------------

hermeticTest(
  'CP-3G-6E a SIGKILL after the claim commit and before dispatch leaves a recoverable uploading row',
  async (context) => {
    const seeded = context.seed(0)
    equal(readQueueRow(context.database, seeded.queueUuid).state, 'pending')

    const marker = await crashAt(context, 'before-dispatch', seeded, (published) => {
      // The claim has committed and not one byte has left the process.
      equal(published.requestCount, 0)
      equal(published.uploadRequestCount, 0)
      equal(published.queueState, 'uploading')
      equal(published.queueAttemptCount, 1)
      ok(typeof published.queueLeaseAt === 'string')
    })

    const found = await runFreshCommand(context, seeded, 'inspect')
    const queue = queueShape(found.queue as Record<string, unknown>)
    const invoice = found.invoice as Record<string, unknown>

    // Read back by a process that was not alive when the worker died.
    equal(queue.state, 'uploading')
    ok(queue.upload_lease_at !== null)
    equal(queue.attempt_count, 1)
    equal(queue.payload_json, seeded.payloadJson)
    equal(queue.payload_hash, seeded.payloadHash)
    equal(queue.idempotency_key, seeded.invoiceUuid)
    equal(invoice.sync_status, 'uploading')
    equal(invoice.remote_uuid, null)
    equal(invoice.server_number, null)
    equal(invoice.synced_at, null)
    equal(invoice.grand_total_amount, 1000)

    const counts = found.localCounts as Record<string, number>
    equal(counts.local_invoices, 1)
    equal(counts.sync_queue, 1)
    equal(counts.sync_conflicts, 0)

    // This process reaches the same conclusion from the same file.
    const here = readQueueRow(context.database, seeded.queueUuid)
    equal(here.state, queue.state)
    equal(here.payload_json, queue.payload_json)
    equal(here.payload_hash, queue.payload_hash)
    equal(here.upload_lease_at, queue.upload_lease_at)
    equal(context.spy.count(), 0)

    recordEvidence({
      case: 'CP-3G-6E-claim-boundary',
      stage: 'before-dispatch',
      killed: 'SIGKILL',
      preCrashQueueState: marker.queueState,
      backendCommitted: false,
      requestsBeforeCrash: marker.requestCount,
      stateAfterRestart: queue.state,
      payloadUnchanged: queue.payload_json === seeded.payloadJson,
      hashUnchanged: queue.payload_hash === seeded.payloadHash,
      localCounts: counts
    })
  }
)

// ---------------------------------------------------------------------------------------------
// CP-3G-6B — the lease boundary, using the production policy
// ---------------------------------------------------------------------------------------------

hermeticTest(
  'CP-3G-6B a lease that has not expired is never reclaimed and never redispatched',
  async (context) => {
    const seeded = context.seed(1)
    await crashAt(context, 'before-dispatch', seeded)

    const leaseAt = readQueueRow(context.database, seeded.queueUuid).upload_lease_at
    ok(leaseAt !== null)
    const leaseStartedAt = Date.parse(leaseAt)

    // The frozen boundary, read straight off the production predicate.
    equal(
      isUploadLeaseExpired(
        leaseAt,
        new Date(leaseStartedAt + LEASE_DURATION_MS - 1),
        LEASE_DURATION_MS
      ),
      false
    )
    equal(
      isUploadLeaseExpired(
        leaseAt,
        new Date(leaseStartedAt + LEASE_DURATION_MS),
        LEASE_DURATION_MS
      ),
      true
    )

    // A startup drain in a fresh process, well inside the lease, must do nothing at all.
    const drained = await runFreshCommand(context, seeded, 'drain', {
      POS_CRASH_NOW_OFFSET_MS: String(leaseStartedAt + 30_000 - Date.now())
    })
    equal(drained.requestCount, 0)
    equal(drained.uploadRequestCount, 0)
    equal(queueShape(drained.queue as Record<string, unknown>).state, 'uploading')

    // And the production reclaim itself refuses, one millisecond short of the boundary.
    const nearBoundary = new Date(leaseStartedAt + LEASE_DURATION_MS - 1).toISOString()
    const reclaimed = context.repositories.syncQueue.reclaimExpiredUploadLeases(
      context.owner,
      nearBoundary,
      (lease, now) => isUploadLeaseExpired(lease, now, LEASE_DURATION_MS)
    )
    deepEqual(reclaimed, [])
    equal(readQueueRow(context.database, seeded.queueUuid).state, 'uploading')
    equal(context.spy.count(), 0)

    recordEvidence({
      case: 'CP-3G-6B-lease-not-expired',
      leaseDurationMs: LEASE_DURATION_MS,
      expiredAtBoundaryMinusOne: false,
      expiredAtBoundary: true,
      startupRequests: drained.requestCount,
      stateAfterStartup: 'uploading'
    })
  }
)

hermeticTest(
  'CP-3G-6B an expired lease is reclaimed to retryable_error and only becomes pending when due',
  async (context) => {
    const seeded = context.seed(2)
    await crashAt(context, 'before-dispatch', seeded)

    const leaseAt = readQueueRow(context.database, seeded.queueUuid).upload_lease_at
    ok(leaseAt !== null)

    // The frozen state machine forbids the shortcut this reclaim is often mistaken for.
    equal(isSyncQueueTransitionAllowed('uploading', 'pending'), false)
    ok(!SYNC_QUEUE_TRANSITIONS.uploading.includes('pending'))
    ok(SYNC_QUEUE_TRANSITIONS.uploading.includes('retryable_error'))

    // Step one, in a fresh process: reclaim alone, so the intermediate state is observable.
    const reclaimResult = await runFreshCommand(context, seeded, 'reclaim-only', {
      POS_CRASH_NOW_OFFSET_MS: String(Date.parse(leaseAt) + LEASE_DURATION_MS - Date.now())
    })
    deepEqual(reclaimResult.reclaimed, [seeded.queueUuid])
    equal(reclaimResult.requestCount, 0)

    // The reclaiming process reached the boundary, using the production predicate.
    const reclaimedAt = String(reclaimResult.nowIso)
    ok(isUploadLeaseExpired(leaseAt, new Date(reclaimedAt), LEASE_DURATION_MS))

    const afterReclaim = queueShape(reclaimResult.queue as Record<string, unknown>)
    equal(afterReclaim.state, 'retryable_error')
    equal(afterReclaim.last_error_code, 'upload_lease_expired')
    equal(afterReclaim.upload_lease_at, null)
    equal(afterReclaim.attempt_count, 1, 'a reclaim is not a dispatch attempt')
    // Reclaim schedules the retry for the reclaim instant itself: due, but only through `pending`.
    equal(afterReclaim.next_attempt_at, reclaimedAt)
    equal(afterReclaim.payload_json, seeded.payloadJson)
    equal(afterReclaim.payload_hash, seeded.payloadHash)
    equal((reclaimResult.invoice as Record<string, unknown>).remote_uuid, null)

    // Step two: before the deadline the row stays retryable_error.
    const beforeDue = new Date(Date.parse(reclaimedAt) - 1).toISOString()
    deepEqual(context.repositories.syncQueue.releaseDueRetries(context.owner, beforeDue), [])
    equal(readQueueRow(context.database, seeded.queueUuid).state, 'retryable_error')
    equal(context.spy.count(), 0)

    // Step three: once due, the one legal release runs.
    deepEqual(context.repositories.syncQueue.releaseDueRetries(context.owner, reclaimedAt), [
      seeded.queueUuid
    ])
    equal(readQueueRow(context.database, seeded.queueUuid).state, 'pending')

    // Step four: the worker claims it again and dispatches exactly once.
    const worker = context.hermeticWorker(Date.parse(reclaimedAt) + 1_000 - Date.now())
    await worker.run()
    worker.shutdown()

    equal(context.spy.count(), 1)
    equal(context.spy.uploadRequests().length, 1)
    equal(context.spy.requests[0]!.pathname, UPLOAD_PATH)
    equal(context.spy.requests[0]!.method, 'POST')
    context.spy.assertEveryRequestInDesktopNamespace()
    deepEqual(JSON.parse(context.spy.requests[0]!.bodyText), seeded.payload)

    const afterDispatch = readQueueRow(context.database, seeded.queueUuid)
    equal(afterDispatch.state, 'retryable_error', 'no server answered, so nothing was resolved')
    equal(afterDispatch.attempt_count, 2)
    equal(afterDispatch.payload_json, seeded.payloadJson)
    equal(afterDispatch.idempotency_key, seeded.invoiceUuid)

    recordEvidence({
      case: 'CP-3G-6B-expired-lease-release',
      transitions: ['uploading', 'retryable_error', 'pending', 'uploading', 'retryable_error'],
      directUploadingToPendingAllowed: isSyncQueueTransitionAllowed('uploading', 'pending'),
      reclaimRequests: reclaimResult.requestCount,
      leaseExpiredErrorCode: afterReclaim.last_error_code,
      attemptCountAfterReclaim: afterReclaim.attempt_count,
      attemptCountAfterDispatch: afterDispatch.attempt_count,
      dispatchRequests: context.spy.count()
    })
  }
)

// ---------------------------------------------------------------------------------------------
// CP-3G-6F — reclaim isolation: what a restart must leave completely alone
// ---------------------------------------------------------------------------------------------

hermeticTest(
  'CP-3G-6F startup recovery neither mutates nor dispatches terminal, leased, undue or foreign rows',
  async (context) => {
    const { syncQueue, localSale } = context.repositories
    const owner = context.owner
    const claimOne = (nowIso: string): string => {
      const claimed = syncQueue.claimNextInvoiceUpload(owner, nowIso)
      ok(claimed !== null)
      return claimed.localQueueUuid
    }
    const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()
    // Negative offsets place a foreign row's lease and backoff deadline far in the past, so an
    // unscoped reconciliation would certainly move them.

    const farFuture = new Date(Date.now() + 3_600_000).toISOString()

    // Each row is driven to its target state through production writers before the next is seeded,
    // so every claim below is unambiguous.
    const syncedRow = context.seed(3)
    claimOne(at(0))
    syncQueue.markUploadSynced(syncedRow.queueUuid, at(0))
    localSale.markInvoiceSynced(syncedRow.invoiceUuid, {
      remoteUuid: testUuid('aa1'),
      serverNumber: 'POS-CP3G6-0001',
      syncedAt: at(0)
    })

    const rejectedRow = context.seed(4)
    claimOne(at(0))
    syncQueue.failUpload(rejectedRow.queueUuid, 'rejected', at(0), {
      errorCode: 'DESKTOP_CATALOG_REVISION_INVALID'
    })
    localSale.markInvoiceUploadFailed(rejectedRow.invoiceUuid, {
      syncStatus: 'rejected',
      lastSyncError: 'DESKTOP_CATALOG_REVISION_INVALID',
      updatedAt: at(0)
    })

    const conflictRow = context.seed(5)
    claimOne(at(0))
    syncQueue.failUpload(conflictRow.queueUuid, 'conflict', at(0), {
      errorCode: 'IDEMPOTENCY_CONFLICT'
    })
    localSale.markInvoiceUploadFailed(conflictRow.invoiceUuid, {
      syncStatus: 'conflict',
      lastSyncError: 'IDEMPOTENCY_CONFLICT',
      updatedAt: at(0)
    })

    const retryNotDueRow = context.seed(6)
    claimOne(at(0))
    syncQueue.failUpload(retryNotDueRow.queueUuid, 'retryable_error', at(0), {
      errorCode: 'SERVICE_UNAVAILABLE',
      nextAttemptAt: farFuture
    })
    localSale.markInvoiceUploadFailed(retryNotDueRow.invoiceUuid, {
      syncStatus: 'retryable_error',
      lastSyncError: 'SERVICE_UNAVAILABLE',
      updatedAt: at(0)
    })

    // An in-flight dispatch whose lease is still valid.
    const leasedRow = context.seed(7)
    claimOne(at(0))

    // A pending row whose backoff deadline has not arrived.
    const pendingNotDueRow = context.seed(8)
    context.database
      .prepare('UPDATE sync_queue SET next_attempt_at = ? WHERE local_queue_uuid = ?')
      .run(farFuture, pendingNotDueRow.queueUuid)

    const foreignCompanyRow = context.seedFor(9, {
      companyUuid: testUuid('bbb'),
      deviceUuid: owner.deviceUuid
    })
    const foreignDeviceRow = context.seedFor(10, {
      companyUuid: owner.companyUuid,
      deviceUuid: testUuid('ccc')
    })

    // A foreign row abandoned mid-dispatch with a long-expired lease, and a foreign row already in
    // backoff and long past due. Both are exactly what an unscoped reconciliation would move.
    const foreignOwner = { companyUuid: testUuid('bbb'), deviceUuid: testUuid('ccc') }
    const foreignExpiredRow = context.seedFor(16, foreignOwner)
    ok(syncQueue.claimNextInvoiceUpload(foreignOwner, at(-7_200_000)) !== null)

    const foreignDueRetryRow = context.seedFor(17, foreignOwner)
    ok(syncQueue.claimNextInvoiceUpload(foreignOwner, at(-7_200_000)) !== null)
    syncQueue.failUpload(foreignDueRetryRow.queueUuid, 'retryable_error', at(-7_200_000), {
      errorCode: 'SERVICE_UNAVAILABLE',
      nextAttemptAt: at(-3_600_000)
    })

    const integrityRow = context.seed(11, { breakPayloadHash: true })

    const queueBefore = allQueueRows(context.database)
    const invoicesBefore = allInvoiceRows(context.database)

    // The production reclaim, run alone: nothing here has an expired lease.
    deepEqual(
      context.repositories.syncQueue.reclaimExpiredUploadLeases(
        context.owner,
        at(0),
        (lease, now) => isUploadLeaseExpired(lease, now, LEASE_DURATION_MS)
      ),
      []
    )
    deepEqual(allQueueRows(context.database), queueBefore)
    deepEqual(allInvoiceRows(context.database), invoicesBefore)

    // The whole startup path: reclaim, release, then drain.
    const worker = context.hermeticWorker(0)
    await worker.run()
    worker.shutdown()

    equal(context.spy.count(), 0, 'startup recovery must send nothing for any of these rows')

    const untouched = [
      syncedRow,
      rejectedRow,
      conflictRow,
      retryNotDueRow,
      leasedRow,
      pendingNotDueRow,
      foreignCompanyRow,
      foreignDeviceRow,
      foreignExpiredRow,
      foreignDueRetryRow
    ]

    for (const row of untouched) {
      const before = queueBefore.find((entry) => entry.local_queue_uuid === row.queueUuid)
      deepEqual(
        allQueueRows(context.database).find((entry) => entry.local_queue_uuid === row.queueUuid),
        before,
        `startup recovery altered a row it must not touch: ${row.queueUuid}`
      )
    }

    // The one row a restart does act on is the locally inconsistent payload — and it is *held*,
    // never repaired, never sent and never terminally rejected.
    const integrity = readQueueRow(context.database, integrityRow.queueUuid)
    equal(integrity.state, 'retryable_error')
    equal(integrity.last_error_code, 'payload_integrity_mismatch')
    equal(integrity.payload_json, integrityRow.payloadJson)
    equal(integrity.idempotency_key, integrityRow.invoiceUuid)
    notEqual(integrity.payload_hash, integrityRow.payloadHash)
    ok(readInvoiceRow(context.database, integrityRow.invoiceUuid) !== undefined)

    const counts = readLocalCounts(context.database)
    equal(counts.sync_queue, 11)
    equal(counts.local_invoices, 11)
    equal(counts.sync_conflicts, 0)

    recordEvidence({
      case: 'CP-3G-6F-reclaim-isolation',
      rowsProtected: untouched.length,
      shapes: [
        'synced',
        'rejected',
        'conflict',
        'retryable-not-due',
        'uploading-unexpired-lease',
        'pending-not-due',
        'foreign-company',
        'foreign-device',
        'foreign-uploading-expired-lease',
        'foreign-retryable-due'
      ],
      startupRequests: context.spy.count(),
      integrityRowState: integrity.state,
      integrityRowErrorCode: integrity.last_error_code,
      integrityPayloadUnchanged: integrity.payload_json === integrityRow.payloadJson
    })
  }
)

hermeticTest(
  'CP-3G-6F an expired lease on a foreign row is left completely unchanged',
  async (context) => {
    const foreignOwner = { companyUuid: testUuid('bbb'), deviceUuid: testUuid('ccc') }
    const foreignRow = context.seedFor(12, foreignOwner)

    // Claimed under its own owner and then abandoned — the only way an uploading row can exist.
    const claimed = context.repositories.syncQueue.claimNextInvoiceUpload(
      foreignOwner,
      new Date().toISOString()
    )
    ok(claimed !== null)
    equal(claimed.localQueueUuid, foreignRow.queueUuid)

    // Everything about the row and its invoice, before this session touches anything.
    const queueBefore = allQueueRows(context.database)
    const invoicesBefore = allInvoiceRows(context.database)

    // A startup reconciliation two hours later: the lease is long expired, so an unscoped reclaim
    // would certainly move it.
    const worker = context.hermeticWorker(LEASE_DURATION_MS + 7_200_000)
    await worker.run()
    worker.shutdown()

    const row = readQueueRow(context.database, foreignRow.queueUuid)

    // Complete before/after equality — not merely "nothing was sent".
    deepEqual(allQueueRows(context.database), queueBefore)
    deepEqual(allInvoiceRows(context.database), invoicesBefore)
    equal(context.spy.count(), 0)
    equal(row.state, 'uploading')
    equal(row.last_error_code, null)
    ok(row.upload_lease_at !== null)
    equal(row.next_attempt_at, null)
    equal(row.attempt_count, 1)
    equal(row.payload_json, foreignRow.payloadJson)
    equal(row.payload_hash, foreignRow.payloadHash)
    equal(readInvoiceRow(context.database, foreignRow.invoiceUuid)?.remote_uuid, null)

    // Still unreachable from this session, exactly as CP-3G-5 proved for a pending foreign row.
    equal(
      context.repositories.syncQueue.claimNextInvoiceUpload(
        context.owner,
        new Date(Date.now() + 3_600_000).toISOString()
      ),
      null
    )

    recordEvidence({
      case: 'CP-3G-6F-foreign-expired-lease',
      startupRequests: context.spy.count(),
      stateAfterStartup: row.state,
      errorCode: row.last_error_code,
      queueRowsByteIdentical: true,
      invoiceRowsByteIdentical: true,
      claimableByThisSession: false
    })
  }
)

// ---------------------------------------------------------------------------------------------
// CP-3G-6G — repeated restarts
// ---------------------------------------------------------------------------------------------

hermeticTest(
  'CP-3G-6G repeated startup reconciliation after a crash is idempotent and counts no dispatch',
  async (context) => {
    const seeded = context.seed(13)
    await crashAt(context, 'before-dispatch', seeded)

    const leaseAt = readQueueRow(context.database, seeded.queueUuid).upload_lease_at
    ok(leaseAt !== null)
    const offsetFor = (afterLeaseMs: number): string =>
      String(Date.parse(leaseAt) + afterLeaseMs - Date.now())

    // First restart: the expired lease is reclaimed exactly once.
    const first = await runFreshCommand(context, seeded, 'reclaim-only', {
      POS_CRASH_NOW_OFFSET_MS: offsetFor(120_000)
    })
    deepEqual(first.reclaimed, [seeded.queueUuid])

    // Second restart: nothing left to reclaim, and the row is not touched again.
    const second = await runFreshCommand(context, seeded, 'reclaim-only', {
      POS_CRASH_NOW_OFFSET_MS: offsetFor(180_000)
    })
    deepEqual(second.reclaimed, [])
    deepEqual(second.queue, first.queue)
    equal(first.requestCount, 0)
    equal(second.requestCount, 0)

    // Three more startup drains, each with the worker paused: still no dispatch, and the attempt
    // count still records only the one real dispatch attempt the crashed process made.
    for (let restart = 0; restart < 3; restart += 1) {
      const drained = await runFreshCommand(context, seeded, 'drain', {
        POS_CRASH_NOW_OFFSET_MS: offsetFor(240_000 + restart * 60_000),
        POS_CRASH_PERMISSION: '0'
      })
      equal(drained.requestCount, 0)
      equal(queueShape(drained.queue as Record<string, unknown>).attempt_count, 1)
    }

    // Only a real dispatch moves the counter.
    const worker = context.hermeticWorker(Date.parse(leaseAt) + 600_000 - Date.now())
    await worker.run()
    worker.shutdown()

    const after = readQueueRow(context.database, seeded.queueUuid)
    equal(context.spy.count(), 1)
    equal(after.attempt_count, 2)

    recordEvidence({
      case: 'CP-3G-6G-repeated-restart',
      restarts: 5,
      reclaimedFirstRestart: first.reclaimed,
      reclaimedSecondRestart: second.reclaimed,
      requestsAcrossRestarts: 0,
      attemptCountBeforeDispatch: 1,
      attemptCountAfterDispatch: after.attempt_count
    })
  }
)

hermeticTest(
  'CP-3G-6G concurrent startup triggers after a crash produce exactly one dispatch',
  async (context) => {
    const seeded = context.seed(14)
    await crashAt(context, 'before-dispatch', seeded)

    const leaseAt = readQueueRow(context.database, seeded.queueUuid).upload_lease_at
    ok(leaseAt !== null)
    const worker = context.hermeticWorker(Date.parse(leaseAt) + 120_000 - Date.now())

    await Promise.all([worker.run(), worker.run(), worker.run()])
    worker.shutdown()

    equal(context.spy.count(), 1)
    equal(context.spy.uploadRequests().length, 1)
    equal(readQueueRow(context.database, seeded.queueUuid).attempt_count, 2)

    recordEvidence({
      case: 'CP-3G-6G-single-flight',
      concurrentTriggers: 3,
      requests: context.spy.count()
    })
  }
)

hermeticTest('CP-3G-6G a synced row is never sent again by any restart', async (context) => {
  const seeded = context.seed(15)
  const claimed = context.repositories.syncQueue.claimNextInvoiceUpload(
    context.owner,
    new Date().toISOString()
  )
  ok(claimed !== null)
  context.repositories.syncQueue.markUploadSynced(seeded.queueUuid, new Date().toISOString())
  context.repositories.localSale.markInvoiceSynced(seeded.invoiceUuid, {
    remoteUuid: testUuid('dd1'),
    serverNumber: 'POS-CP3G6-0002',
    syncedAt: new Date().toISOString()
  })

  for (let restart = 0; restart < 3; restart += 1) {
    const worker = context.hermeticWorker(restart * 600_000)
    await worker.run()
    worker.shutdown()
  }

  const row = readQueueRow(context.database, seeded.queueUuid)
  equal(context.spy.count(), 0)
  equal(row.state, 'synced')
  equal(row.attempt_count, 1)
  equal(row.upload_lease_at, null)

  recordEvidence({
    case: 'CP-3G-6G-synced-never-resent',
    restarts: 3,
    requests: context.spy.count(),
    state: row.state
  })
})

// ---------------------------------------------------------------------------------------------
// CP-3G-6A / CP-3G-6C — the server committed, the acknowledgment never arrived
// ---------------------------------------------------------------------------------------------

/** The backend effects of exactly one scenario, keyed by its own offline number and grant. */
function effectsFor(seeded: SeededInvoice): BackendScenarioEffects {
  const identity = uploadIdentity(seeded.payload)

  return readScenarioEffects(identity.offlineNumber, identity.allocationUuid, seeded.invoiceUuid)
}

/** Asserts the one-and-only-once shape of a committed upload's server-side effects. */
function assertExactlyOnce(effects: BackendScenarioEffects): void {
  equal(effects.invoicesForOfflineNumber, 1)
  equal(effects.itemsForOfflineNumber, 1)
  equal(effects.paymentsForOfflineNumber, 1)
  equal(effects.uploadAuditsForInvoice, 1)
  equal(effects.movementsForOfflineNumber, 1)
  equal(effects.consumptionsForAllocation, 1)
  equal(effects.allocationConsumedMilli, 1000)
  ok(effects.postCloseAdjustmentsForOfflineNumber <= 1)
  ok(effects.invoiceUuid !== null)
  ok(effects.serverNumber !== null)
}

liveTest(
  'CP-3G-6A a SIGKILL after the server commits and before the local acknowledgment loses nothing',
  async (context) => {
    const seeded = context.seed(LIVE_PAYLOAD_BASE)
    const identity = uploadIdentity(seeded.payload)
    const before = effectsFor(seeded)
    equal(before.invoicesForOfflineNumber, 0)

    let committed: BackendScenarioEffects | null = null

    const marker = await crashAt(context, 'response-received', seeded, (published) => {
      equal(published.requestCount, 1)
      equal(published.uploadRequestCount, 1)
      equal(published.requestPath, UPLOAD_PATH)
      equal(published.requestMethod, 'POST')
      equal(published.status, 201)
      equal(published.queueState, 'uploading')

      // Test-side confirmation, taken from the server's own database while the worker is still
      // parked: Laravel really committed, and the desktop has not been told.
      committed = effectsFor(seeded)
      assertExactlyOnce(committed)
    })

    ok(committed !== null)
    const serverTruth: BackendScenarioEffects = committed

    // What a completely new process finds on disk.
    const found = await runFreshCommand(context, seeded, 'inspect')
    const crashed = queueShape(found.queue as Record<string, unknown>)
    const crashedInvoice = found.invoice as Record<string, unknown>

    equal(crashed.state, 'uploading')
    ok(crashed.upload_lease_at !== null)
    equal(crashed.attempt_count, 1)
    equal(crashed.payload_json, seeded.payloadJson)
    equal(crashed.payload_hash, seeded.payloadHash)
    equal(crashed.idempotency_key, seeded.invoiceUuid)
    equal(crashedInvoice.remote_uuid, null)
    equal(crashedInvoice.synced_at, null)
    deepEqual(found.localCounts, {
      local_invoices: 1,
      local_invoice_items: 0,
      local_invoice_payments: 0,
      sync_queue: 1,
      sync_conflicts: 0,
      local_stock_movements: 0,
      local_stock_allocation_consumptions: 0
    })
    deepEqual(effectsFor(seeded), serverTruth, 'the crash changed nothing on the server')

    // Recovery, in another process again: expired lease, legal release, identical replay.
    const recovery = await runFreshCommand(context, seeded, 'drain', {
      POS_CRASH_NOW_OFFSET_MS: String(Date.parse(crashed.upload_lease_at!) + 120_000 - Date.now())
    })
    const recovered = queueShape(recovery.queue as Record<string, unknown>)
    const recoveredInvoice = recovery.invoice as Record<string, unknown>
    const summary = recovery.summary as Record<string, number | null>

    equal(recovery.uploadRequestCount, 1, 'exactly one request per retry attempt')
    equal(recovery.requestCount, 1)
    deepEqual(recovery.requestPaths, [UPLOAD_PATH])

    // The replay is the same bytes, the same key and the same business identity as the request
    // that the server already committed.
    equal(recovery.requestBodySha256, marker.requestBodySha256)
    deepEqual(recovery.requestIdentity, marker.requestIdentity)
    deepEqual(recovery.requestIdentity, identity)

    // 200 DESKTOP_INVOICE_ALREADY_UPLOADED, treated as the success it is.
    equal(summary.duplicates, 1)
    equal(summary.uploaded, 0)
    equal(summary.failed, 0)
    equal(summary.pausedReason, null)

    equal(recovered.state, 'synced')
    equal(recovered.attempt_count, 2)
    equal(recovered.upload_lease_at, null)
    equal(recovered.last_error_code, null)
    equal(recovered.payload_json, seeded.payloadJson)
    equal(recovered.payload_hash, seeded.payloadHash)
    equal(recoveredInvoice.sync_status, 'synced')
    equal(recoveredInvoice.remote_uuid, serverTruth.invoiceUuid)
    equal(recoveredInvoice.server_number, serverTruth.serverNumber)
    ok(recoveredInvoice.synced_at !== null)

    // One invoice, one of every effect, unchanged by the retry.
    const after = effectsFor(seeded)
    assertExactlyOnce(after)
    deepEqual(after, serverTruth)

    // A further restart sends nothing at all.
    const settled = await runFreshCommand(context, seeded, 'drain', {
      POS_CRASH_NOW_OFFSET_MS: '600000'
    })
    equal(settled.requestCount, 0)
    equal(queueShape(settled.queue as Record<string, unknown>).state, 'synced')
    deepEqual(settled.localCounts, found.localCounts)
    deepEqual(effectsFor(seeded), serverTruth)

    recordEvidence({
      case: 'CP-3G-6A/6C-server-committed-ack-lost',
      stage: 'response-received',
      killed: 'SIGKILL',
      backendCommittedBeforeKill: true,
      preCrashQueueState: marker.queueState,
      stateAfterRestart: crashed.state,
      transitions: ['pending', 'uploading', 'retryable_error', 'pending', 'uploading', 'synced'],
      leaseAtAfterCrash: crashed.upload_lease_at,
      requestsBeforeCrash: marker.requestCount,
      requestsOnRetry: recovery.uploadRequestCount,
      requestsAfterSuccess: settled.requestCount,
      identicalBodyDigest: recovery.requestBodySha256 === marker.requestBodySha256,
      identicalIdempotencyKey: recovered.idempotency_key === seeded.invoiceUuid,
      identicalPayloadJson: recovered.payload_json === seeded.payloadJson,
      identicalPayloadHash: recovered.payload_hash === seeded.payloadHash,
      convergedAs: 'duplicate',
      backendInvoices: after.invoicesForOfflineNumber,
      backendItems: after.itemsForOfflineNumber,
      backendPayments: after.paymentsForOfflineNumber,
      backendUploadAudits: after.uploadAuditsForInvoice,
      backendMovements: after.movementsForOfflineNumber,
      backendConsumptions: after.consumptionsForAllocation,
      allocationConsumedMilli: after.allocationConsumedMilli,
      stockQuantity: after.stockQuantity,
      postCloseAdjustments: after.postCloseAdjustmentsForOfflineNumber,
      localCounts: settled.localCounts
    })
  }
)

// ---------------------------------------------------------------------------------------------
// CP-3G-6D — the crash happened before the server committed anything
// ---------------------------------------------------------------------------------------------

liveTest(
  'CP-3G-6D a SIGKILL before the server commits recovers into a normal single creation',
  async (context) => {
    const seeded = context.seed(LIVE_PAYLOAD_BASE + 1)
    const identity = uploadIdentity(seeded.payload)
    equal(effectsFor(seeded).invoicesForOfflineNumber, 0)

    const marker = await crashAt(context, 'before-dispatch', seeded, (published) => {
      equal(published.requestCount, 0)
      equal(published.queueState, 'uploading')
      // Nothing was sent, so the server cannot hold anything for this key.
      equal(effectsFor(seeded).invoicesForOfflineNumber, 0)
    })

    const found = await runFreshCommand(context, seeded, 'inspect')
    const crashed = queueShape(found.queue as Record<string, unknown>)
    equal(crashed.state, 'uploading')
    equal(effectsFor(seeded).invoicesForOfflineNumber, 0)

    const recovery = await runFreshCommand(context, seeded, 'drain', {
      POS_CRASH_NOW_OFFSET_MS: String(Date.parse(crashed.upload_lease_at!) + 120_000 - Date.now())
    })
    const recovered = queueShape(recovery.queue as Record<string, unknown>)
    const summary = recovery.summary as Record<string, number | null>

    equal(recovery.uploadRequestCount, 1)
    deepEqual(recovery.requestIdentity, identity)
    // A first commit, not a replay: this is the arm that distinguishes 6D from 6A.
    equal(summary.uploaded, 1)
    equal(summary.duplicates, 0)
    equal(recovered.state, 'synced')
    equal(recovered.attempt_count, 2)
    equal(recovered.upload_lease_at, null)

    const after = effectsFor(seeded)
    assertExactlyOnce(after)
    equal((recovery.invoice as Record<string, unknown>).remote_uuid, after.invoiceUuid)

    const settled = await runFreshCommand(context, seeded, 'drain', {
      POS_CRASH_NOW_OFFSET_MS: '600000'
    })
    equal(settled.requestCount, 0)
    deepEqual(effectsFor(seeded), after)

    recordEvidence({
      case: 'CP-3G-6D-pre-commit-crash',
      stage: 'before-dispatch',
      killed: 'SIGKILL',
      backendCommittedBeforeKill: false,
      preCrashQueueState: marker.queueState,
      stateAfterRestart: crashed.state,
      transitions: ['pending', 'uploading', 'retryable_error', 'pending', 'uploading', 'synced'],
      requestsBeforeCrash: marker.requestCount,
      requestsOnRetry: recovery.uploadRequestCount,
      requestsAfterSuccess: settled.requestCount,
      convergedAs: 'created',
      backendInvoices: after.invoicesForOfflineNumber,
      backendConsumptions: after.consumptionsForAllocation,
      allocationConsumedMilli: after.allocationConsumedMilli,
      localCounts: settled.localCounts
    })
  }
)

// ---------------------------------------------------------------------------------------------
// CP-3G-6E — the remaining boundaries inside one dispatch
// ---------------------------------------------------------------------------------------------

/**
 * One boundary, end to end: crash there, read the disk from a new process, recover from another,
 * and assert the same invariant regardless of whether the server had committed — exactly one
 * invoice, one set of effects, one local invoice, one queue row and no orphan.
 */
function boundaryTest(
  name: string,
  stage: CrashStage,
  payloadIndex: number,
  atBoundary: (marker: Record<string, unknown>) => void
): void {
  liveTest(name, async (context) => {
    const seeded = context.seed(payloadIndex)
    const identity = uploadIdentity(seeded.payload)
    equal(effectsFor(seeded).invoicesForOfflineNumber, 0)

    let committedBeforeKill = false

    const marker = await crashAt(context, stage, seeded, (published) => {
      atBoundary(published)
      committedBeforeKill = effectsFor(seeded).invoicesForOfflineNumber === 1
    })

    // A process that was never alive during the crash reads the file itself.
    const found = await runFreshCommand(context, seeded, 'inspect')
    const crashed = queueShape(found.queue as Record<string, unknown>)
    const crashedInvoice = found.invoice as Record<string, unknown>

    equal(crashed.state, 'uploading', 'a killed dispatch leaves the row leased, never resolved')
    ok(crashed.upload_lease_at !== null)
    equal(crashed.attempt_count, 1)
    equal(crashed.payload_json, seeded.payloadJson)
    equal(crashed.payload_hash, seeded.payloadHash)
    equal(crashed.idempotency_key, seeded.invoiceUuid)
    equal(crashedInvoice.remote_uuid, null)
    equal(crashedInvoice.synced_at, null)
    equal((found.localCounts as Record<string, number>).local_invoices, 1)
    equal((found.localCounts as Record<string, number>).sync_queue, 1)

    const recovery = await runFreshCommand(context, seeded, 'drain', {
      POS_CRASH_NOW_OFFSET_MS: String(Date.parse(crashed.upload_lease_at!) + 120_000 - Date.now())
    })
    const recovered = queueShape(recovery.queue as Record<string, unknown>)
    const summary = recovery.summary as Record<string, number | null>

    equal(recovery.uploadRequestCount, 1)
    deepEqual(recovery.requestPaths, [UPLOAD_PATH])
    deepEqual(recovery.requestIdentity, identity)
    equal(recovered.state, 'synced')
    equal(recovered.attempt_count, 2)
    equal(recovered.upload_lease_at, null)
    equal(recovered.payload_json, seeded.payloadJson)
    equal(recovered.payload_hash, seeded.payloadHash)

    // Whichever answer the server gave, it accepted exactly one invoice for this key.
    equal((summary.uploaded ?? 0) + (summary.duplicates ?? 0), 1)
    equal(summary.failed, 0)

    const after = effectsFor(seeded)
    assertExactlyOnce(after)
    equal((recovery.invoice as Record<string, unknown>).remote_uuid, after.invoiceUuid)
    equal((recovery.invoice as Record<string, unknown>).server_number, after.serverNumber)

    const settled = await runFreshCommand(context, seeded, 'drain', {
      POS_CRASH_NOW_OFFSET_MS: '600000'
    })
    equal(settled.requestCount, 0)
    equal(queueShape(settled.queue as Record<string, unknown>).state, 'synced')
    equal((settled.localCounts as Record<string, number>).local_invoices, 1)
    equal((settled.localCounts as Record<string, number>).sync_queue, 1)
    equal((settled.localCounts as Record<string, number>).sync_conflicts, 0)
    deepEqual(effectsFor(seeded), after)

    recordEvidence({
      case: `CP-3G-6E-${stage}`,
      stage,
      killed: 'SIGKILL',
      backendCommittedBeforeKill: committedBeforeKill,
      preCrashQueueState: marker.queueState,
      requestsBeforeCrash: marker.requestCount,
      stateAfterRestart: crashed.state,
      leaseAtAfterCrash: crashed.upload_lease_at,
      transitions: ['pending', 'uploading', 'retryable_error', 'pending', 'uploading', 'synced'],
      requestsOnRetry: recovery.uploadRequestCount,
      requestsAfterSuccess: settled.requestCount,
      identicalPayloadJson: recovered.payload_json === seeded.payloadJson,
      identicalPayloadHash: recovered.payload_hash === seeded.payloadHash,
      identicalIdempotencyKey: recovered.idempotency_key === seeded.invoiceUuid,
      convergedAs: (summary.duplicates ?? 0) === 1 ? 'duplicate' : 'created',
      backendInvoices: after.invoicesForOfflineNumber,
      backendItems: after.itemsForOfflineNumber,
      backendPayments: after.paymentsForOfflineNumber,
      backendUploadAudits: after.uploadAuditsForInvoice,
      backendMovements: after.movementsForOfflineNumber,
      backendConsumptions: after.consumptionsForAllocation,
      allocationConsumedMilli: after.allocationConsumedMilli,
      postCloseAdjustments: after.postCloseAdjustmentsForOfflineNumber,
      localCounts: settled.localCounts
    })
  })
}

boundaryTest(
  'CP-3G-6E a SIGKILL while the request is in flight converges on one invoice',
  'in-flight',
  LIVE_PAYLOAD_BASE + 2,
  (published) => {
    equal(published.dispatched, true)
    equal(published.requestCount, 1)
    equal(published.requestPath, UPLOAD_PATH)
    equal(published.queueState, 'uploading')
  }
)

boundaryTest(
  'CP-3G-6E a SIGKILL after the answer is accepted and before the outcome transaction converges on one invoice',
  'before-outcome',
  LIVE_PAYLOAD_BASE + 3,
  (published) => {
    equal(published.acceptedKind, 'created')
    equal(published.remoteUuidPresent, true)
    equal(published.requestCount, 1)
    // The answer is in hand and the queue row is still exactly as the claim left it.
    equal(published.queueState, 'uploading')
  }
)

boundaryTest(
  'CP-3G-6E a SIGKILL inside the outcome transaction discards the half-written success',
  'during-outcome',
  LIVE_PAYLOAD_BASE + 4,
  (published) => {
    equal(published.queueRowWrittenInsideOpenTransaction, true)
    equal(published.requestCount, 1)
    // Seen from inside the still-open transaction the row already reads `synced`; the reopened
    // database below must show that this was never committed.
    equal(published.queueState, 'synced')
  }
)

// ---------------------------------------------------------------------------------------------
// CP-3G-6H — the owner-scoping correction
//
// CP-3G-6 originally recorded that `reclaimExpiredUploadLeases` was not owner-scoped, and argued
// that this was safe because it dispatched nothing. That was insufficient: writing a foreign row's
// state is a cross-owner mutation whether or not a request follows. These cases prove the corrected
// contract — reconciliation acts only for the authoritative company/device, and every other row is
// left byte-identical.
// ---------------------------------------------------------------------------------------------

const FOREIGN_COMPANY = testUuid('bbb')
const FOREIGN_DEVICE = testUuid('ccc')

/** Every foreign shape an unscoped reconciliation would have moved. */
function seedForeignExpiredRows(context: CrashContext): {
  readonly rows: readonly { readonly label: string; readonly seeded: SeededInvoice }[]
} {
  const owner = context.owner
  const shapes = [
    {
      label: 'foreign-company-same-device',
      companyUuid: FOREIGN_COMPANY,
      deviceUuid: owner.deviceUuid
    },
    {
      label: 'same-company-foreign-device',
      companyUuid: owner.companyUuid,
      deviceUuid: FOREIGN_DEVICE
    },
    {
      label: 'foreign-company-foreign-device',
      companyUuid: FOREIGN_COMPANY,
      deviceUuid: FOREIGN_DEVICE
    }
  ]
  const rows = shapes.map((shape, index) => {
    const seeded = context.seedFor(20 + index, shape)
    // Claimed and abandoned two hours ago under its own owner: a long-expired uploading row.
    const claimed = context.repositories.syncQueue.claimNextInvoiceUpload(
      { companyUuid: shape.companyUuid, deviceUuid: shape.deviceUuid },
      new Date(Date.now() - 7_200_000).toISOString()
    )
    ok(claimed !== null, `${shape.label} could not be claimed under its own owner`)
    equal(claimed.localQueueUuid, seeded.queueUuid)

    return { label: shape.label, seeded }
  })

  return { rows }
}

/** The pre-correction candidate set: every `uploading` invoice-upload row, with no owner filter. */
function unscopedUploadingRows(database: SqliteDatabase): readonly string[] {
  return (
    database
      .prepare(
        `SELECT local_queue_uuid FROM sync_queue
         WHERE aggregate_type = 'invoice' AND operation = 'upload' AND state = 'uploading'
         ORDER BY local_queue_uuid ASC`
      )
      .all() as { readonly local_queue_uuid: string }[]
  ).map((row) => row.local_queue_uuid)
}

hermeticTest(
  'CP-3G-6H reclaim is scoped to the authoritative company and device, and moves nothing else',
  async (context) => {
    const owned = context.seed(18)
    await crashAt(context, 'before-dispatch', owned)

    const foreign = seedForeignExpiredRows(context)
    const leaseAt = readQueueRow(context.database, owned.queueUuid).upload_lease_at
    ok(leaseAt !== null)

    // The original defect's precondition, reproduced rather than assumed: under the pre-correction
    // query every one of these rows — owned and foreign alike — was a reclaim candidate.
    const unscoped = unscopedUploadingRows(context.database)
    equal(unscoped.length, 4)
    for (const row of foreign.rows) {
      ok(
        unscoped.includes(row.seeded.queueUuid),
        `${row.label} would have been reclaimed by the unscoped query`
      )
    }

    const queueBefore = allQueueRows(context.database)
    const invoicesBefore = allInvoiceRows(context.database)
    const foreignBefore = queueBefore.filter((row) =>
      foreign.rows.some((entry) => entry.seeded.queueUuid === row.local_queue_uuid)
    )

    // The corrected production reclaim, at a moment when every lease above is expired.
    const reclaimed = context.repositories.syncQueue.reclaimExpiredUploadLeases(
      context.owner,
      new Date(Date.parse(leaseAt) + LEASE_DURATION_MS + 1_000).toISOString(),
      (lease, now) => isUploadLeaseExpired(lease, now, LEASE_DURATION_MS)
    )

    // Exactly the owned row, and only the owned row.
    deepEqual(reclaimed, [owned.queueUuid])
    equal(readQueueRow(context.database, owned.queueUuid).state, 'retryable_error')
    equal(readQueueRow(context.database, owned.queueUuid).last_error_code, 'upload_lease_expired')

    for (const row of foreign.rows) {
      const before = foreignBefore.find((entry) => entry.local_queue_uuid === row.seeded.queueUuid)
      const after = allQueueRows(context.database).find(
        (entry) => entry.local_queue_uuid === row.seeded.queueUuid
      )
      deepEqual(after, before, `${row.label} was mutated by a reconciliation it does not belong to`)
    }

    // A whole startup drain reaches the same conclusion and sends nothing.
    const worker = context.hermeticWorker(
      Date.parse(leaseAt) + LEASE_DURATION_MS + 2_000 - Date.now()
    )
    await worker.run()
    worker.shutdown()

    equal(context.spy.count(), 1, 'only the owned row is ever dispatched')
    equal(context.spy.uploadRequests()[0]!.pathname, UPLOAD_PATH)

    for (const row of foreign.rows) {
      const before = invoicesBefore.find((entry) => entry.local_uuid === row.seeded.invoiceUuid)
      const after = allInvoiceRows(context.database).find(
        (entry) => entry.local_uuid === row.seeded.invoiceUuid
      )
      deepEqual(after, before, `${row.label}'s invoice was mutated`)
      deepEqual(
        allQueueRows(context.database).find(
          (entry) => entry.local_queue_uuid === row.seeded.queueUuid
        ),
        foreignBefore.find((entry) => entry.local_queue_uuid === row.seeded.queueUuid)
      )
    }

    recordEvidence({
      case: 'CP-3G-6H-owner-scoped-reclaim',
      unscopedCandidateCount: unscoped.length,
      scopedReclaimed: reclaimed,
      foreignShapes: foreign.rows.map((row) => row.label),
      foreignRowsByteIdentical: true,
      requests: context.spy.count()
    })
  }
)

hermeticTest(
  'CP-3G-6H no authoritative session owner reconciles nothing and writes nothing',
  async (context) => {
    const owned = context.seed(19)
    await crashAt(context, 'before-dispatch', owned)

    const foreign = seedForeignExpiredRows(context)
    equal(foreign.rows.length, 3)

    const queueBefore = allQueueRows(context.database)
    const invoicesBefore = allInvoiceRows(context.database)

    const emptySessions: readonly InvoiceUploadWorkerSessionReader[] = [
      // No session at all.
      { getContext: () => ({ isAuthenticated: false, companyUuid: null, deviceUuid: null }) },
      // A cleared session that still reports a company but no device, and the reverse.
      {
        getContext: () => ({
          isAuthenticated: true,
          companyUuid: context.owner.companyUuid,
          deviceUuid: null
        })
      },
      {
        getContext: () => ({
          isAuthenticated: true,
          companyUuid: null,
          deviceUuid: context.owner.deviceUuid
        })
      },
      // Authenticated flag lowered while the identifiers linger.
      {
        getContext: () => ({
          isAuthenticated: false,
          companyUuid: context.owner.companyUuid,
          deviceUuid: context.owner.deviceUuid
        })
      }
    ]

    for (const session of emptySessions) {
      const worker = context.hermeticWorker(7_200_000, { session })
      await worker.run()
      worker.shutdown()
    }

    // Zero writes anywhere, including the row this session would otherwise have owned.
    deepEqual(allQueueRows(context.database), queueBefore)
    deepEqual(allInvoiceRows(context.database), invoicesBefore)
    equal(context.spy.count(), 0)
    equal(readQueueRow(context.database, owned.queueUuid).state, 'uploading')

    recordEvidence({
      case: 'CP-3G-6H-no-session-owner',
      sessionShapes: emptySessions.length,
      queueRowsByteIdentical: true,
      invoiceRowsByteIdentical: true,
      requests: context.spy.count()
    })
  }
)

hermeticTest(
  'CP-3G-6H a different cashier and a rotated session epoch do not block recovery',
  async (context) => {
    const otherUser = testUuid('eee')
    const seeded = context.seedFor(23, context.owner)
    context.database
      .prepare(
        'UPDATE local_invoices SET user_uuid = ?, commit_session_epoch = 1 WHERE local_uuid = ?'
      )
      .run(otherUser, seeded.invoiceUuid)

    await crashAt(context, 'before-dispatch', seeded)

    // The cashier who committed the sale is not the one recovering it, and the session has rotated
    // since. Neither is an ownership predicate: the backend attributes from the immutable shift.
    const epoch = context.repositories.sessionEpoch.increment()
    ok(epoch > 1)
    equal(
      (
        context.database
          .prepare(
            'SELECT user_uuid, commit_session_epoch FROM local_invoices WHERE local_uuid = ?'
          )
          .get(seeded.invoiceUuid) as { user_uuid: string; commit_session_epoch: number }
      ).user_uuid,
      otherUser
    )

    const leaseAt = readQueueRow(context.database, seeded.queueUuid).upload_lease_at
    ok(leaseAt !== null)

    const reclaimed = context.repositories.syncQueue.reclaimExpiredUploadLeases(
      context.owner,
      new Date(Date.parse(leaseAt) + LEASE_DURATION_MS + 1_000).toISOString(),
      (lease, now) => isUploadLeaseExpired(lease, now, LEASE_DURATION_MS)
    )
    deepEqual(reclaimed, [seeded.queueUuid])

    const worker = context.hermeticWorker(
      Date.parse(leaseAt) + LEASE_DURATION_MS + 2_000 - Date.now()
    )
    await worker.run()
    worker.shutdown()

    equal(context.spy.count(), 1, "a colleague's queued sale is still this device's to upload")
    equal(readQueueRow(context.database, seeded.queueUuid).attempt_count, 2)

    recordEvidence({
      case: 'CP-3G-6H-cross-user-and-epoch',
      committedByAnotherCashier: true,
      sessionEpochAfterRotation: epoch,
      reclaimed,
      requests: context.spy.count()
    })
  }
)

hermeticTest(
  'CP-3G-6H the row becomes recoverable once its real owner is the authoritative session',
  async (context) => {
    const foreignOwner = { companyUuid: FOREIGN_COMPANY, deviceUuid: FOREIGN_DEVICE }
    const seeded = context.seedFor(24, foreignOwner)
    const claimed = context.repositories.syncQueue.claimNextInvoiceUpload(
      foreignOwner,
      new Date(Date.now() - 7_200_000).toISOString()
    )
    ok(claimed !== null)

    const before = allQueueRows(context.database)

    // This session is not its owner: nothing at all happens.
    const stranger = context.hermeticWorker(7_200_000)
    await stranger.run()
    stranger.shutdown()

    deepEqual(allQueueRows(context.database), before)
    equal(context.spy.count(), 0)

    // A later login restores the row's real company/device as the authoritative session, and the
    // same production reconciliation now recovers it. Nothing polls, and no owner is fabricated.
    const rightful = context.hermeticWorker(7_200_000, { owner: foreignOwner })
    await rightful.run()
    rightful.shutdown()

    const row = readQueueRow(context.database, seeded.queueUuid)
    equal(context.spy.count(), 1)
    equal(row.attempt_count, 2, 'the rightful owner reclaimed, released and redispatched it')
    equal(row.payload_json, seeded.payloadJson)
    equal(row.idempotency_key, seeded.invoiceUuid)

    recordEvidence({
      case: 'CP-3G-6H-later-login-recovers',
      requestsUnderForeignSession: 0,
      requestsUnderRightfulSession: context.spy.count(),
      attemptCountAfterRecovery: row.attempt_count
    })
  }
)

hermeticTest(
  'CP-3G-6H two owners reconciling the same database each touch only their own row',
  async (context) => {
    const foreignOwner = { companyUuid: FOREIGN_COMPANY, deviceUuid: FOREIGN_DEVICE }
    const mine = context.seedFor(25, context.owner)
    ok(
      context.repositories.syncQueue.claimNextInvoiceUpload(
        context.owner,
        new Date(Date.now() - 7_200_000).toISOString()
      ) !== null
    )
    const theirs = context.seedFor(26, foreignOwner)
    ok(
      context.repositories.syncQueue.claimNextInvoiceUpload(
        foreignOwner,
        new Date(Date.now() - 7_200_000).toISOString()
      ) !== null
    )

    const mineWorker = context.hermeticWorker(7_200_000)
    const theirsWorker = context.hermeticWorker(7_200_000, { owner: foreignOwner })

    await Promise.all([mineWorker.run(), theirsWorker.run()])
    mineWorker.shutdown()
    theirsWorker.shutdown()

    // Each row advanced exactly once, under its own owner, and neither reclaim crossed over.
    equal(readQueueRow(context.database, mine.queueUuid).attempt_count, 2)
    equal(readQueueRow(context.database, theirs.queueUuid).attempt_count, 2)
    equal(context.spy.count(), 2)
    equal(readQueueRow(context.database, mine.queueUuid).payload_json, mine.payloadJson)
    equal(readQueueRow(context.database, theirs.queueUuid).payload_json, theirs.payloadJson)

    recordEvidence({
      case: 'CP-3G-6H-concurrent-owners',
      owners: 2,
      requests: context.spy.count(),
      crossOwnerMutation: false
    })
  }
)

hermeticTest(
  'CP-3G-6H the owner predicate is enforced by the update itself, not only by the read',
  async (context) => {
    const seeded = context.seedFor(27, context.owner)
    ok(
      context.repositories.syncQueue.claimNextInvoiceUpload(
        context.owner,
        new Date(Date.now() - 7_200_000).toISOString()
      ) !== null
    )

    const before = allQueueRows(context.database)

    // Ownership is taken away *after* the reclaim read has already matched the row and *before* its
    // update runs. If the predicate lived only in the SELECT, the update would still land.
    const racing = realRepositories(
      failingDatabase(context.database, {
        failOnWriteNumber: -1,
        onWrite: (writeNumber) => {
          if (writeNumber === 1) {
            context.database
              .prepare('UPDATE local_invoices SET device_uuid = ? WHERE local_uuid = ?')
              .run(FOREIGN_DEVICE, seeded.invoiceUuid)
          }
        }
      })
    )

    let refused = false

    try {
      racing.syncQueue.reclaimExpiredUploadLeases(
        context.owner,
        new Date().toISOString(),
        (lease, now) => isUploadLeaseExpired(lease, now, LEASE_DURATION_MS)
      )
    } catch {
      refused = true
    }

    ok(refused, 'an update whose owner predicate no longer holds must not be treated as applied')

    // The whole transaction was discarded: the queue row and the ownership change are both gone.
    deepEqual(allQueueRows(context.database), before)
    equal(readQueueRow(context.database, seeded.queueUuid).state, 'uploading')
    equal(
      (
        context.database
          .prepare('SELECT device_uuid FROM local_invoices WHERE local_uuid = ?')
          .get(seeded.invoiceUuid) as { device_uuid: string }
      ).device_uuid,
      context.owner.deviceUuid
    )
    equal(context.spy.count(), 0)

    recordEvidence({
      case: 'CP-3G-6H-atomic-owner-predicate',
      ownershipRevokedBetweenReadAndWrite: true,
      updateRefused: refused,
      queueRowsByteIdentical: true,
      requests: context.spy.count()
    })
  }
)

hermeticTest(
  'CP-3G-6H owner-scoped reconciliation is idempotent across repeated restarts',
  async (context) => {
    const seeded = context.seed(28)
    await crashAt(context, 'before-dispatch', seeded)

    const foreign = seedForeignExpiredRows(context)
    const leaseAt = readQueueRow(context.database, seeded.queueUuid).upload_lease_at
    ok(leaseAt !== null)
    const at = new Date(Date.parse(leaseAt) + LEASE_DURATION_MS + 1_000).toISOString()
    const expired = (lease: string | null, now: Date): boolean =>
      isUploadLeaseExpired(lease, now, LEASE_DURATION_MS)

    deepEqual(
      context.repositories.syncQueue.reclaimExpiredUploadLeases(context.owner, at, expired),
      [seeded.queueUuid]
    )

    const afterFirst = allQueueRows(context.database)

    for (let restart = 0; restart < 3; restart += 1) {
      deepEqual(
        context.repositories.syncQueue.reclaimExpiredUploadLeases(context.owner, at, expired),
        []
      )
      deepEqual(allQueueRows(context.database), afterFirst)
    }

    for (const row of foreign.rows) {
      equal(readQueueRow(context.database, row.seeded.queueUuid).state, 'uploading')
      equal(readQueueRow(context.database, row.seeded.queueUuid).last_error_code, null)
    }

    equal(context.spy.count(), 0)

    recordEvidence({
      case: 'CP-3G-6H-idempotent-owner-scoped-reconciliation',
      restarts: 4,
      reclaimedAfterFirst: [],
      foreignRowsUntouched: foreign.rows.length,
      requests: context.spy.count()
    })
  }
)
