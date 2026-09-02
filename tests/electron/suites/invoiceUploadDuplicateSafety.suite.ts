import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import { createPublicError } from '../../../src/main/http/apiError'
import { payloadHash } from '../../../src/main/services/localSale.fingerprint'
import { uploadInvoice } from '../../../src/main/sync/invoiceUpload.client'
import { InvoiceUploadOutcomeRecorder } from '../../../src/main/sync/invoiceUploadOutcome'
import { subscribeInvoiceUploadTriggers } from '../../../src/main/sync/invoiceUploadTriggers'
import { InvoiceUploadWorker } from '../../../src/main/sync/invoiceUploadWorker'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  liveUploadBackendAvailable,
  liveUploadFixture,
  readBackendSnapshot,
  type BackendSnapshot
} from '../support/liveUploadBackend'
import { createUploadTransportSpy, type UploadTransportSpy } from '../support/uploadTransportSpy'

const HASH_64 = 'a'.repeat(64)
const USER = '44444444-4444-4444-8444-444444444444'
const UPLOAD_PATH = '/api/v1/desktop/invoices/upload'

/**
 * CP-3G-5 — duplicate safety, proven end to end.
 *
 * Real Electron SQLite (production migrations, production repositories), the real
 * `InvoiceUploadWorker`, the real `uploadInvoice` client, the real `DesktopApiClient`, and a real
 * Laravel server on a disposable database. The only thing between the client and Laravel is a
 * counting transport spy, which forwards every request and — for the lost-acknowledgment arm —
 * decides only what the *worker* gets to observe after the server has already committed.
 *
 * The suite skips itself when no live backend was provided, so the ordinary
 * `npm run test:sqlite:electron` gate stays hermetic.
 */
function liveTest(name: string, callback: (context: LiveContext) => Promise<void>): void {
  databaseTest(
    name,
    async (sandbox) => {
      const context = createLiveContext(sandbox)

      try {
        await callback(context)
      } finally {
        if (process.env.CP3G5_LEDGER === '1') {
          // The one-request-per-attempt ledger, measured at the transport boundary.
          console.log(
            `LEDGER\t${context.spy.count()}\t${context.spy.uploadRequests().length}\t${name}`
          )
        }

        // Close first so a failed assertion surfaces as itself, not as a sandbox leak error.
        context.close()
      }
    },
    { skip: liveUploadBackendAvailable() ? false : 'no live CP-3G-5 backend provided' }
  )
}

interface LiveContext {
  readonly sandbox: DatabaseSandbox
  readonly database: SqliteDatabase
  readonly repositories: RealRepositories
  readonly spy: UploadTransportSpy
  readonly apiClient: DesktopApiClient
  seed(payloadIndex: number, options?: SeedOptions): SeededRow
  buildWorker(overrides?: WorkerOverrides): InvoiceUploadWorker
  close(): void
}

interface SeedOptions {
  readonly companyUuid?: string
  readonly deviceUuid?: string
  /** Corrupt the stored hash so the integrity gate must refuse to send. */
  readonly breakPayloadHash?: boolean
  /** Store something that is not the minted payload (still hashed correctly). */
  readonly payloadOverride?: Record<string, unknown>
}

interface SeededRow {
  readonly invoiceUuid: string
  readonly queueUuid: string
  readonly payload: Record<string, unknown>
  readonly payloadJson: string
}

interface WorkerOverrides {
  readonly allowSync?: boolean
  readonly denialCode?: string
  readonly hasPermission?: boolean
  readonly authenticated?: boolean
  readonly companyUuid?: string | null
  readonly deviceUuid?: string | null
}

function createLiveContext(sandbox: DatabaseSandbox): LiveContext {
  const fixture = liveUploadFixture()
  ok(fixture !== null)

  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const spy = createUploadTransportSpy()

  // The production client. Only its transport is instrumented.
  const apiClient = new DesktopApiClient({
    apiOrigin: new URL(fixture.origin),
    getAccessToken: () => fixture.token,
    getDeviceUuid: () => fixture.deviceUuid,
    fetchImplementation: spy.fetchImplementation,
    timeoutMs: 20_000
  })

  let counter = 0

  return {
    sandbox,
    database,
    repositories,
    spy,
    apiClient,
    seed(payloadIndex, options = {}) {
      counter += 1

      return seedQueuedInvoice(database, repositories, {
        n: String(counter),
        payload: (options.payloadOverride ?? fixture.payloads[payloadIndex]) as Record<
          string,
          unknown
        >,
        companyUuid: options.companyUuid ?? fixture.companyUuid,
        deviceUuid: options.deviceUuid ?? fixture.deviceUuid,
        shiftUuid: fixture.shiftUuid,
        breakPayloadHash: options.breakPayloadHash ?? false
      })
    },
    buildWorker(overrides = {}) {
      const recorder = new InvoiceUploadOutcomeRecorder({
        database,
        syncQueue: repositories.syncQueue,
        localSale: repositories.localSale,
        syncConflicts: repositories.syncConflicts
      })

      return new InvoiceUploadWorker({
        syncQueue: repositories.syncQueue,
        recorder,
        commercialAccess: {
          assertAllowed: (): void => {
            if (overrides.allowSync === false) {
              throw createPublicError('authorization', 'Sync is not permitted.', false, {
                backendCode: overrides.denialCode ?? 'COMMERCIAL_ACCESS_LICENSE_EXPIRED'
              })
            }
          }
        },
        permissions: { hasPermission: () => overrides.hasPermission !== false },
        session: {
          getContext: () => ({
            isAuthenticated: overrides.authenticated !== false,
            companyUuid:
              overrides.companyUuid === undefined ? fixture.companyUuid : overrides.companyUuid,
            deviceUuid:
              overrides.deviceUuid === undefined ? fixture.deviceUuid : overrides.deviceUuid
          })
        },
        // The real client function over the real HTTP client.
        upload: (payloadJson) => uploadInvoice(apiClient, payloadJson),
        schedule: () => () => undefined
      })
    },
    close() {
      closeDatabase(database)
    }
  }
}

/** A committed sale plus its one immutable invoice-upload queue row, exactly as Phase 3F leaves it. */
function seedQueuedInvoice(
  database: SqliteDatabase,
  repositories: RealRepositories,
  options: {
    readonly n: string
    readonly payload: Record<string, unknown>
    readonly companyUuid: string
    readonly deviceUuid: string
    readonly shiftUuid: string
    readonly breakPayloadHash: boolean
  }
): SeededRow {
  const invoiceUuid = String(options.payload.local_invoice_uuid)
  const queueUuid = uuid(`2${options.n}`)
  const attemptKey = uuid(`3${options.n}`)
  const createdAt = '2026-09-02T10:00:00.000Z'
  const payloadJson = JSON.stringify(options.payload)

  repositories.saleAttempts.claim({
    attemptKey,
    companyUuid: options.companyUuid,
    deviceUuid: options.deviceUuid,
    userUuid: USER,
    claimSessionEpoch: 1,
    originShiftUuid: options.shiftUuid,
    originShiftObservedAt: createdAt,
    originBranchUuid: uuid('8'),
    originWarehouseUuid: uuid('7'),
    originContextFingerprint: HASH_64,
    intentFingerprint: HASH_64,
    intentVersion: 1,
    intentJson: '{"v":1}'
  })

  repositories.localSale.insertInvoice({
    localUuid: invoiceUuid,
    attemptKey,
    offlineNumber: String(options.payload.offline_number ?? `CP3G5-${options.n}`),
    companyUuid: options.companyUuid,
    branchUuid: uuid('8'),
    warehouseUuid: uuid('7'),
    deviceUuid: options.deviceUuid,
    userUuid: USER,
    shiftUuid: options.shiftUuid,
    commitSessionEpoch: 1,
    catalogRevision: String(options.payload.catalog_revision),
    intentFingerprint: HASH_64,
    customerUuid: null,
    currency: 'USD',
    currencyExponent: 2,
    taxMode: 'none',
    invoiceDiscountType: null,
    invoiceDiscountValue: 0,
    subtotalAmount: 1000,
    discountTotalAmount: 0,
    taxTotalAmount: 0,
    grandTotalAmount: 1000,
    paidTotalAmount: 1000,
    changeDueAmount: 0,
    soldAt: createdAt,
    // Phase 3F CHECK: sold_while_offline=1 requires an offline/unknown connectivity state.
    connectivityStateAtSale: 'offline',
    soldWhileOffline: true,
    notes: null,
    commercialSnapshotJson: '{}',
    createdAt
  })

  repositories.saleAttempts.markCommitted(attemptKey, invoiceUuid, createdAt)

  repositories.syncQueue.enqueue({
    localQueueUuid: queueUuid,
    aggregateType: 'invoice',
    localAggregateUuid: invoiceUuid,
    operation: 'upload',
    payloadJson,
    // The production hash over the canonical payload — the exact integrity gate the worker re-runs.
    payloadHash: options.breakPayloadHash ? HASH_64 : payloadHash(options.payload),
    idempotencyKey: invoiceUuid
  })

  database
    .prepare('UPDATE sync_queue SET created_at = ?, updated_at = ? WHERE local_queue_uuid = ?')
    .run(createdAt, createdAt, queueUuid)

  return { invoiceUuid, queueUuid, payload: options.payload, payloadJson }
}

function uuid(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
}

interface QueueRow {
  readonly state: string
  readonly attempt_count: number
  readonly upload_lease_at: string | null
  readonly last_error_code: string | null
  readonly next_attempt_at: string | null
}

interface InvoiceRow {
  readonly sync_status: string
  readonly remote_uuid: string | null
  readonly server_number: string | null
  readonly synced_at: string | null
  readonly sync_attempts: number
}

function queueRow(database: SqliteDatabase, queueUuid: string): QueueRow {
  return database
    .prepare(
      'SELECT state, attempt_count, upload_lease_at, last_error_code, next_attempt_at FROM sync_queue WHERE local_queue_uuid = ?'
    )
    .get(queueUuid) as QueueRow
}

function invoiceRow(database: SqliteDatabase, invoiceUuid: string): InvoiceRow {
  return database
    .prepare(
      'SELECT sync_status, remote_uuid, server_number, synced_at, sync_attempts FROM local_invoices WHERE local_uuid = ?'
    )
    .get(invoiceUuid) as InvoiceRow
}

function localCounts(database: SqliteDatabase): Record<string, number> {
  const tables = [
    'local_invoices',
    'local_invoice_items',
    'local_invoice_payments',
    'sync_queue',
    'sync_conflicts'
  ]
  const counts: Record<string, number> = {}

  for (const table of tables) {
    counts[table] = (
      database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }
    ).total
  }

  return counts
}

function delta(before: BackendSnapshot, after: BackendSnapshot): Record<string, number> {
  const result: Record<string, number> = {}

  for (const [table, value] of Object.entries(after.counts)) {
    result[table] = value - (before.counts[table] ?? 0)
  }

  return result
}

// ---------------------------------------------------------------------------------------------
// CP-3G-5A — normal synchronization against the real endpoint
// ---------------------------------------------------------------------------------------------

liveTest(
  'CP-3G-5A a queued invoice uploads once, synchronizes, and is never dispatched again',
  async (context) => {
    const before = readBackendSnapshot()
    const seeded = context.seed(0)
    const worker = context.buildWorker()

    equal(localCounts(context.database).local_invoices, 1)
    equal(localCounts(context.database).sync_queue, 1)

    const summary = await worker.run()

    const after = readBackendSnapshot()
    const changes = delta(before, after)

    // Exactly one outbound request, POST, on the one permitted route.
    equal(context.spy.count(), 1)
    equal(context.spy.uploadRequests().length, 1)
    equal(context.spy.requests[0]!.method, 'POST')
    equal(context.spy.requests[0]!.pathname, UPLOAD_PATH)
    ok(context.spy.requests[0]!.hasAuthorization)
    ok(context.spy.requests[0]!.hasDeviceHeader)
    context.spy.assertEveryRequestInDesktopNamespace()

    // The body is the frozen payload, semantically identical to what was committed.
    deepEqual(JSON.parse(context.spy.requests[0]!.bodyText), seeded.payload)
    equal(JSON.parse(context.spy.requests[0]!.bodyText).idempotency_key, seeded.invoiceUuid)

    // Server side: exactly one invoice, one item, one payment, one movement, one consumption.
    equal(changes.pos_invoices, 1)
    equal(changes.pos_invoice_items, 1)
    equal(changes.pos_payments, 1)
    equal(changes.desktop_invoice_syncs, 1)
    equal(changes.stock_movements, 1)
    equal(changes.stock_allocation_consumptions, 1)

    // Local side: still one invoice, one queue row, both synced atomically.
    const counts = localCounts(context.database)
    equal(counts.local_invoices, 1)
    equal(counts.sync_queue, 1)
    equal(counts.sync_conflicts, 0)

    const queue = queueRow(context.database, seeded.queueUuid)
    const invoice = invoiceRow(context.database, seeded.invoiceUuid)
    equal(queue.state, 'synced')
    equal(queue.upload_lease_at, null)
    equal(queue.attempt_count, 1)
    equal(invoice.sync_status, 'synced')
    ok(invoice.remote_uuid !== null)
    ok(invoice.server_number !== null)
    ok(invoice.synced_at !== null)

    // The remote identity written locally is the identity the server actually holds.
    const created = after.invoices.find((row) => !before.invoiceUuids.includes(row.uuid))
    ok(created !== undefined)
    equal(invoice.remote_uuid, created.uuid)
    equal(invoice.server_number, created.server_number)

    // Historical attribution is derived from the immutable shift, never from the uploader or the
    // device's current assignment (BE-3G-0 row 4).
    const fixture = liveUploadFixture()
    ok(fixture !== null)
    const shift = after.shifts.find((row) => row.uuid === fixture.shiftUuid)
    ok(shift !== undefined)
    equal(created.shift_id, shift.id)
    equal(created.cashier_user_id, shift.user_id)
    equal(created.branch_id, shift.branch_id)
    equal(created.warehouse_id, shift.warehouse_id)

    // The BE-3F-3 uploader audit row is written beside the invoice.
    const audit = after.uploadAudits.find((row) => row.local_invoice_uuid === seeded.invoiceUuid)
    ok(audit !== undefined, 'an accepted upload must record its uploader audit row')
    equal(audit.idempotency_key, seeded.invoiceUuid)
    equal(audit.origin_shift_id, shift.id)
    equal(audit.uploader_user_id, shift.user_id)
    equal(audit.client_contract_version, 2)
    equal(audit.legacy_path_used, 0)

    equal(summary.uploaded, 1)
    equal(summary.duplicates, 0)
    equal(summary.pausedReason, null)

    // A post-success drain sends nothing: the row is terminal.
    await worker.run()
    equal(context.spy.uploadRequests().length, 1)
    equal(queueRow(context.database, seeded.queueUuid).state, 'synced')
    equal(readBackendSnapshot().counts.pos_invoices, after.counts.pos_invoices)

    context.close()
  }
)

// ---------------------------------------------------------------------------------------------
// CP-3G-5B — lost acknowledgment: the server commits, the answer never arrives
// ---------------------------------------------------------------------------------------------

liveTest(
  'CP-3G-5B a lost acknowledgment retries the same key and converges on one invoice',
  async (context) => {
    const before = readBackendSnapshot()
    const seeded = context.seed(1)
    const worker = context.buildWorker()

    // Attempt 1: the request reaches Laravel and commits; only the answer is lost.
    context.spy.program({ kind: 'lose-acknowledgment' })
    await worker.run()

    const afterFirst = readBackendSnapshot()
    const firstChanges = delta(before, afterFirst)

    // The server really did commit exactly one invoice.
    equal(firstChanges.pos_invoices, 1)
    equal(firstChanges.stock_movements, 1)
    equal(firstChanges.stock_allocation_consumptions, 1)
    equal(context.spy.uploadRequests().length, 1)

    const committed = afterFirst.invoices.find((row) => !before.invoiceUuids.includes(row.uuid))
    ok(committed !== undefined)

    // The worker observed a transport failure, so the row is retryable — never synced, never
    // terminal, and never left orphaned in `uploading`.
    const afterFirstQueue = queueRow(context.database, seeded.queueUuid)
    equal(afterFirstQueue.state, 'retryable_error')
    equal(afterFirstQueue.upload_lease_at, null)
    equal(afterFirstQueue.attempt_count, 1)
    // The invoice mirrors the queue state, and — the point of the whole arm — carries no remote
    // identity: the desktop has learned nothing about whether the server holds the invoice.
    equal(invoiceRow(context.database, seeded.invoiceUuid).sync_status, 'retryable_error')
    equal(invoiceRow(context.database, seeded.invoiceUuid).remote_uuid, null)
    equal(invoiceRow(context.database, seeded.invoiceUuid).synced_at, null)
    equal(localCounts(context.database).sync_conflicts, 0)

    // Attempt 2: release the due retry through production policy and drain again.
    context.database
      .prepare('UPDATE sync_queue SET next_attempt_at = ? WHERE local_queue_uuid = ?')
      .run('2026-09-02T10:00:00.000Z', seeded.queueUuid)

    await worker.run()

    const afterSecond = readBackendSnapshot()

    // Two attempts, two requests, one per attempt.
    equal(context.spy.uploadRequests().length, 2)

    const [first, second] = context.spy.uploadRequests()
    const firstBody = JSON.parse(first!.bodyText) as Record<string, unknown>
    const secondBody = JSON.parse(second!.bodyText) as Record<string, unknown>

    // Identical idempotency key, invoice uuid, shift and allocation proof — nothing regenerated.
    equal(secondBody.idempotency_key, firstBody.idempotency_key)
    equal(secondBody.idempotency_key, seeded.invoiceUuid)
    equal(secondBody.local_invoice_uuid, firstBody.local_invoice_uuid)
    equal(secondBody.shift_uuid, firstBody.shift_uuid)
    deepEqual(secondBody, firstBody)
    deepEqual(secondBody, seeded.payload)
    equal(payloadHash(secondBody), payloadHash(seeded.payload))

    // Laravel converged through its committed replay — no second effect of any kind.
    equal(delta(before, afterSecond).pos_invoices, 1)
    equal(delta(before, afterSecond).pos_invoice_items, 1)
    equal(delta(before, afterSecond).pos_payments, 1)
    equal(delta(before, afterSecond).stock_movements, 1)
    equal(delta(before, afterSecond).stock_allocation_consumptions, 1)
    equal(afterSecond.allocationConsumedMilli, afterFirst.allocationConsumedMilli)
    equal(afterSecond.stockQuantity, afterFirst.stockQuantity)
    equal(
      afterSecond.uploadAudits.filter((row) => row.local_invoice_uuid === seeded.invoiceUuid)
        .length,
      1,
      'a replayed key must not create a second uploader audit row'
    )

    // The local row is now synced onto the identity the first attempt created.
    const queue = queueRow(context.database, seeded.queueUuid)
    const invoice = invoiceRow(context.database, seeded.invoiceUuid)
    equal(queue.state, 'synced')
    equal(queue.upload_lease_at, null)
    equal(queue.attempt_count, 2)
    equal(invoice.sync_status, 'synced')
    equal(invoice.remote_uuid, committed.uuid)
    equal(invoice.server_number, committed.server_number)
    ok(invoice.synced_at !== null)

    const counts = localCounts(context.database)
    equal(counts.local_invoices, 1)
    equal(counts.sync_queue, 1)
    equal(counts.sync_conflicts, 0)

    context.close()
  }
)

// ---------------------------------------------------------------------------------------------
// CP-3G-5C — a duplicate answer as the first thing this process ever observes
// ---------------------------------------------------------------------------------------------

liveTest(
  'CP-3G-5C a 200 duplicate answer is first-observed success, never an error',
  async (context) => {
    const fixture = liveUploadFixture()
    ok(fixture !== null)

    // Commit the invoice server-side out of band, exactly as a previous process would have.
    const payload = fixture.payloads[2] as Record<string, unknown>
    const priming = await fetch(new URL(UPLOAD_PATH, fixture.origin), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        'X-Device-UUID': fixture.deviceUuid,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    })
    equal(priming.status, 201)

    const before = readBackendSnapshot()
    const seeded = context.seed(2)
    const worker = context.buildWorker()

    const summary = await worker.run()
    const after = readBackendSnapshot()

    // The only answer this process ever saw was the 200 duplicate.
    equal(context.spy.uploadRequests().length, 1)
    equal(summary.duplicates, 1)
    equal(summary.uploaded, 0)
    equal(summary.failed, 0)
    equal(summary.pausedReason, null)

    // Treated exactly like a 201 locally, and no second server effect.
    equal(delta(before, after).pos_invoices, 0)
    equal(delta(before, after).stock_movements, 0)
    equal(delta(before, after).stock_allocation_consumptions, 0)

    const queue = queueRow(context.database, seeded.queueUuid)
    const invoice = invoiceRow(context.database, seeded.invoiceUuid)
    equal(queue.state, 'synced')
    equal(queue.last_error_code, null)
    equal(invoice.sync_status, 'synced')
    ok(invoice.remote_uuid !== null)
    ok(invoice.server_number !== null)
    equal(localCounts(context.database).sync_conflicts, 0)
    equal(localCounts(context.database).sync_queue, 1)

    context.close()
  }
)

// ---------------------------------------------------------------------------------------------
// CP-3G-5D — dispatch cardinality and single-flight
// ---------------------------------------------------------------------------------------------

liveTest(
  'CP-3G-5D overlapping triggers coalesce into one attempt and one outbound request',
  async (context) => {
    const before = readBackendSnapshot()
    const seeded = context.seed(3)
    const worker = context.buildWorker()

    // The production trigger seam, wired exactly as the composition root wires it.
    const listeners = new Set<() => void>()
    const disposeTrigger = subscribeInvoiceUploadTriggers({
      accessPublisher: {
        onPublished: (listener) => {
          listeners.add(listener)

          return () => listeners.delete(listener)
        }
      },
      worker
    })
    const publish = (): void => {
      for (const listener of listeners) {
        listener()
      }
    }

    // A trigger storm: app-start style run, three access-restoration publications, and two manual
    // upload-now presses, all overlapping one in-flight drain.
    const first = worker.run()
    publish()
    publish()
    worker.requestRun()
    publish()
    worker.requestRun()
    await first
    // Let any coalesced rerun settle.
    await worker.run()

    const after = readBackendSnapshot()

    // Six triggers, one claim, one outbound request, one invoice.
    equal(context.spy.uploadRequests().length, 1)
    equal(delta(before, after).pos_invoices, 1)
    equal(queueRow(context.database, seeded.queueUuid).attempt_count, 1)
    equal(queueRow(context.database, seeded.queueUuid).state, 'synced')
    equal(localCounts(context.database).sync_queue, 1)

    // Post-success storm: the row is terminal, so nothing more leaves the process.
    publish()
    worker.requestRun()
    publish()
    await worker.run()
    await worker.run()

    equal(context.spy.uploadRequests().length, 1)
    equal(readBackendSnapshot().counts.pos_invoices, after.counts.pos_invoices)

    disposeTrigger()
    context.spy.assertEveryRequestInDesktopNamespace()
    context.close()
  }
)

liveTest('CP-3G-5D a restart with a pending row uploads it exactly once', async (context) => {
  const before = readBackendSnapshot()
  const seeded = context.seed(4)

  // A second worker over the same database is what a restart looks like to the queue.
  const firstProcess = context.buildWorker()
  const restarted = context.buildWorker()

  await firstProcess.run()
  await restarted.run()

  equal(context.spy.uploadRequests().length, 1)
  equal(delta(before, readBackendSnapshot()).pos_invoices, 1)
  equal(queueRow(context.database, seeded.queueUuid).state, 'synced')
  equal(queueRow(context.database, seeded.queueUuid).attempt_count, 1)
  equal(localCounts(context.database).sync_queue, 1)

  context.close()
})

liveTest('CP-3G-5D two concurrent drains cannot both claim the same row', async (context) => {
  const before = readBackendSnapshot()
  const seeded = context.seed(5)
  const worker = context.buildWorker()

  // Two independent workers over one database: only the winning claim may dispatch.
  const rival = context.buildWorker()
  await Promise.all([worker.run(), rival.run()])

  equal(context.spy.uploadRequests().length, 1)
  equal(delta(before, readBackendSnapshot()).pos_invoices, 1)
  equal(queueRow(context.database, seeded.queueUuid).state, 'synced')
  equal(localCounts(context.database).sync_queue, 1)

  context.close()
})

// ---------------------------------------------------------------------------------------------
// CP-3G-5E — zero-send security and integrity guards
// ---------------------------------------------------------------------------------------------

interface ZeroSendCase {
  readonly name: string
  readonly seed: SeedOptions
  readonly worker: WorkerOverrides
  /** The queue state the row must still be in afterwards. */
  readonly expectedState: string
  readonly prepare?: (context: LiveContext, seeded: SeededRow) => void
}

const ZERO_SEND_CASES: readonly ZeroSendCase[] = [
  {
    name: 'a payload whose hash no longer matches',
    seed: { breakPayloadHash: true },
    worker: {},
    expectedState: 'retryable_error'
  },
  {
    name: 'a stored payload that is not valid JSON',
    seed: { payloadOverride: undefined },
    worker: {},
    expectedState: 'retryable_error'
  },
  {
    name: 'a terminal synced row',
    seed: {},
    worker: {},
    expectedState: 'synced',
    prepare: (context, seeded) => {
      context.repositories.syncQueue.transition(seeded.queueUuid, 'uploading')
      context.repositories.syncQueue.markUploadSynced(seeded.queueUuid)
    }
  },
  {
    name: 'a terminal rejected row',
    seed: {},
    worker: {},
    expectedState: 'rejected',
    prepare: (context, seeded) => {
      context.repositories.syncQueue.transition(seeded.queueUuid, 'uploading')
      context.repositories.syncQueue.transition(seeded.queueUuid, 'rejected')
    }
  },
  {
    name: 'a terminal conflict row',
    seed: {},
    worker: {},
    expectedState: 'conflict',
    prepare: (context, seeded) => {
      context.repositories.syncQueue.transition(seeded.queueUuid, 'uploading')
      context.repositories.syncQueue.transition(seeded.queueUuid, 'conflict')
    }
  },
  {
    name: 'a row owned by another company',
    seed: { companyUuid: '99999999-9999-4999-8999-999999999999' },
    worker: {},
    expectedState: 'pending'
  },
  {
    name: 'a row owned by another device',
    seed: { deviceUuid: '88888888-8888-4888-8888-888888888888' },
    worker: {},
    expectedState: 'pending'
  },
  {
    name: 'a cleared session',
    seed: {},
    worker: { authenticated: false },
    expectedState: 'pending'
  },
  {
    name: 'a session with no device identity',
    seed: {},
    worker: { deviceUuid: null },
    expectedState: 'pending'
  },
  {
    name: 'a missing pos.invoice.upload permission',
    seed: {},
    worker: { hasPermission: false },
    expectedState: 'pending'
  },
  {
    name: 'commercial access denying canSync',
    seed: {},
    worker: { allowSync: false, denialCode: 'COMMERCIAL_ACCESS_LICENSE_EXPIRED' },
    expectedState: 'pending'
  },
  {
    name: 'an offline connectivity precondition',
    seed: {},
    worker: { allowSync: false, denialCode: 'COMMERCIAL_ACCESS_CONNECTIVITY_OFFLINE' },
    expectedState: 'pending'
  }
]

for (const [index, zeroSend] of ZERO_SEND_CASES.entries()) {
  liveTest(`CP-3G-5E zero send — ${zeroSend.name}`, async (context) => {
    const before = readBackendSnapshot()
    const localBefore = localCounts(context.database)

    const seedOptions =
      zeroSend.name === 'a stored payload that is not valid JSON'
        ? { ...zeroSend.seed }
        : zeroSend.seed
    // Every zero-send case can share one minted payload: each runs in its own sandbox database,
    // and by definition none of them ever reaches the server.
    void index
    const seeded = context.seed(6, seedOptions)

    if (zeroSend.name === 'a stored payload that is not valid JSON') {
      // A payload that cannot be parsed at all: the integrity gate must refuse before any send.
      context.database
        .prepare('UPDATE sync_queue SET payload_json = ? WHERE local_queue_uuid = ?')
        .run('{not json', seeded.queueUuid)
    }

    zeroSend.prepare?.(context, seeded)

    const worker = context.buildWorker(zeroSend.worker)
    await worker.run()

    // The whole point: nothing left the process.
    equal(context.spy.count(), 0, 'a guarded row must produce zero outbound requests')

    // Server untouched.
    deepEqual(readBackendSnapshot().counts, before.counts)

    // Local business rows untouched, and no second queue row was ever created.
    const localAfter = localCounts(context.database)
    equal(localAfter.local_invoices, localBefore.local_invoices + 1)
    equal(localAfter.sync_queue, localBefore.sync_queue + 1)
    equal(localAfter.sync_conflicts, localBefore.sync_conflicts)

    equal(queueRow(context.database, seeded.queueUuid).state, zeroSend.expectedState)

    context.close()
  })
}

liveTest(
  'CP-3G-5E the upload route is the only desktop endpoint the worker can reach',
  async (context) => {
    // resolveDesktopApiUrl is the single chokepoint; these are the shapes it must refuse.
    for (const path of [
      '/api/v1/admin/companies',
      '/api/v1/auth/login',
      '/../../etc/passwd',
      '//evil.example.com/api/v1/desktop/invoices/upload',
      'https://evil.example.com/api/v1/desktop/invoices/upload',
      '/api/v1/desktop/invoices/upload/../../admin'
    ]) {
      let refused = false

      try {
        await context.apiClient.request({
          method: 'POST',
          path,
          requiresAuth: true
        } as never)
      } catch {
        refused = true
      }

      ok(refused, `The API client accepted a forbidden path: ${path}`)
    }

    // Not one of those attempts reached the network.
    equal(context.spy.count(), 0)

    context.close()
  }
)

// ---------------------------------------------------------------------------------------------
// CP-3G-5F — response and error safety
// ---------------------------------------------------------------------------------------------

/**
 * A 2xx the desktop cannot read is never success.
 *
 * The server may well hold the invoice, so the row stays retryable and the next attempt replays the
 * same key and converges on the duplicate answer. What must never happen is `synced` written over a
 * body that carried no remote identity.
 */
const MALFORMED_SUCCESSES: readonly {
  readonly name: string
  readonly status: number
  readonly body: unknown
}[] = [
  { name: 'a success envelope that is not an envelope at all', status: 200, body: { ok: true } },
  {
    name: 'a success code the desktop does not recognize',
    status: 200,
    body: {
      success: true,
      message: 'ok',
      code: 'DESKTOP_INVOICE_SOMETHING_NEW',
      data: { id: 'x', server_number: 'y' },
      meta: {}
    }
  },
  {
    name: 'a success body with no remote invoice identity',
    status: 201,
    body: {
      success: true,
      message: 'ok',
      code: 'DESKTOP_INVOICE_UPLOADED',
      data: { server_number: 'POS-1' },
      meta: {}
    }
  },
  {
    name: 'a success body whose identity fields are the wrong type',
    status: 201,
    body: {
      success: true,
      message: 'ok',
      code: 'DESKTOP_INVOICE_UPLOADED',
      data: { id: 12345, server_number: false },
      meta: {}
    }
  }
]

for (const malformed of MALFORMED_SUCCESSES) {
  liveTest(`CP-3G-5F ${malformed.name} never marks the row synced`, async (context) => {
    const seeded = context.seed(7)
    const worker = context.buildWorker()

    context.spy.program({ kind: 'replace-body', status: malformed.status, body: malformed.body })
    await worker.run()

    equal(context.spy.uploadRequests().length, 1)

    const queue = queueRow(context.database, seeded.queueUuid)
    const invoice = invoiceRow(context.database, seeded.invoiceUuid)

    ok(queue.state !== 'synced', 'a malformed success must never produce a synced queue row')
    equal(queue.state, 'retryable_error')
    equal(queue.upload_lease_at, null)
    equal(invoice.sync_status, 'retryable_error')
    equal(invoice.remote_uuid, null)
    equal(invoice.server_number, null)
    equal(invoice.synced_at, null)
    equal(localCounts(context.database).sync_conflicts, 0)
    equal(localCounts(context.database).sync_queue, 1)

    context.close()
  })
}

liveTest(
  'CP-3G-5F a transport failure keeps the payload and key identical for the retry',
  async (context) => {
    const seeded = context.seed(8)
    const worker = context.buildWorker()

    context.spy.program({ kind: 'transport-failure' })
    await worker.run()

    const afterFailure = queueRow(context.database, seeded.queueUuid)
    equal(afterFailure.state, 'retryable_error')
    ok(afterFailure.next_attempt_at !== null, 'a retryable failure must schedule a backoff')
    equal(afterFailure.upload_lease_at, null)

    // The stored payload and key are untouched — a retry cannot drift.
    const stored = context.database
      .prepare(
        'SELECT payload_json, payload_hash, idempotency_key FROM sync_queue WHERE local_queue_uuid = ?'
      )
      .get(seeded.queueUuid) as {
      payload_json: string
      payload_hash: string
      idempotency_key: string
    }
    equal(stored.payload_json, seeded.payloadJson)
    equal(stored.payload_hash, payloadHash(seeded.payload))
    equal(stored.idempotency_key, seeded.invoiceUuid)

    context.close()
  }
)

liveTest(
  'CP-3G-5F a 5xx and an unknown backend code are retryable, never terminal',
  async (context) => {
    const answers = [
      {
        payloadIndex: 9,
        status: 503,
        body: {
          success: false,
          message: 'down',
          code: 'SERVICE_UNAVAILABLE',
          errors: null,
          meta: {}
        }
      },
      {
        payloadIndex: 10,
        status: 418,
        body: {
          success: false,
          message: 'new',
          code: 'DESKTOP_SOMETHING_THE_DESKTOP_HAS_NEVER_SEEN',
          errors: null,
          meta: { trace_id: 'trace-cp3g5' }
        }
      }
    ] as const

    for (const { payloadIndex, status, body } of answers) {
      const seeded = context.seed(payloadIndex)
      const worker = context.buildWorker()

      context.spy.program({ kind: 'replace-body', status, body })
      await worker.run()

      const queue = queueRow(context.database, seeded.queueUuid)
      equal(queue.state, 'retryable_error', `status ${status} must stay retryable`)
      equal(invoiceRow(context.database, seeded.invoiceUuid).remote_uuid, null)
      equal(localCounts(context.database).sync_conflicts, 0)
    }

    context.close()
  }
)

liveTest(
  'CP-3G-5F an authorization denial pauses the worker instead of rejecting the invoice',
  async (context) => {
    const seeded = context.seed(11)
    const worker = context.buildWorker()

    context.spy.program({
      kind: 'replace-body',
      status: 403,
      body: {
        success: false,
        message: 'Sync is not permitted.',
        code: 'FORBIDDEN',
        errors: null,
        meta: { trace_id: 'trace-cp3g5' }
      }
    })
    const summary = await worker.run()

    // The item did nothing wrong, so no item-level terminal state may be written for it.
    const queue = queueRow(context.database, seeded.queueUuid)
    ok(queue.state !== 'rejected')
    ok(queue.state !== 'conflict')
    ok(queue.state !== 'synced')
    ok(summary.pausedReason !== null, 'an access denial must pause the worker')
    equal(invoiceRow(context.database, seeded.invoiceUuid).remote_uuid, null)
    equal(localCounts(context.database).sync_queue, 1)

    context.close()
  }
)

liveTest(
  'CP-3G-5F a real 422 catalog-revision rejection is terminal and preserves the sale',
  async (context) => {
    const fixture = liveUploadFixture()
    ok(fixture !== null)

    const before = readBackendSnapshot()
    const payload = {
      ...(fixture.payloads[12] as Record<string, unknown>),
      catalog_revision: 'f'.repeat(64)
    }
    const seeded = context.seed(12, { payloadOverride: payload })
    const worker = context.buildWorker()

    await worker.run()

    // Laravel really answered; nothing was created.
    equal(context.spy.uploadRequests().length, 1)
    deepEqual(readBackendSnapshot().counts, before.counts)

    const queue = queueRow(context.database, seeded.queueUuid)
    equal(queue.state, 'rejected')
    ok(queue.last_error_code !== null)

    // PD-3G-1: the local sale is preserved exactly, never negated.
    const invoice = invoiceRow(context.database, seeded.invoiceUuid)
    equal(invoice.sync_status, 'rejected')
    equal(invoice.remote_uuid, null)
    equal(localCounts(context.database).local_invoices, 1)
    equal(localCounts(context.database).sync_queue, 1)

    // Terminal means terminal: a further drain sends nothing.
    await worker.run()
    equal(context.spy.uploadRequests().length, 1)

    context.close()
  }
)

liveTest(
  'CP-3G-5F a real 422 allocation-proof rejection is terminal and sends once',
  async (context) => {
    const fixture = liveUploadFixture()
    ok(fixture !== null)

    const before = readBackendSnapshot()
    const source = fixture.payloads[13] as Record<string, unknown>
    // A tracked line arriving with no allocation proof: the backend must refuse it.
    const items = (source.items as Record<string, unknown>[]).map((item) => {
      const rest = { ...item }
      delete rest.allocations

      return rest
    })
    const seeded = context.seed(13, { payloadOverride: { ...source, items } })
    const worker = context.buildWorker()

    await worker.run()

    equal(context.spy.uploadRequests().length, 1)
    deepEqual(readBackendSnapshot().counts, before.counts)
    equal(queueRow(context.database, seeded.queueUuid).state, 'rejected')
    equal(invoiceRow(context.database, seeded.invoiceUuid).remote_uuid, null)
    equal(localCounts(context.database).sync_queue, 1)

    context.close()
  }
)

liveTest(
  'CP-3G-5F a real 409 idempotency conflict is preserved for a human, never auto-retried',
  async (context) => {
    const fixture = liveUploadFixture()
    ok(fixture !== null)

    // Commit the invoice under this key with one payload...
    const original = fixture.payloads[14] as Record<string, unknown>
    const priming = await fetch(new URL(UPLOAD_PATH, fixture.origin), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        'X-Device-UUID': fixture.deviceUuid,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(original)
    })

    equal(priming.status, 201)

    const before = readBackendSnapshot()

    // ...then queue a *different* payload under the same idempotency key.
    const drifted = {
      ...original,
      notes: 'a payload that disagrees with the one already committed under this key'
    }
    const seeded = context.seed(14, { payloadOverride: drifted })
    const worker = context.buildWorker()

    await worker.run()

    equal(context.spy.uploadRequests().length, 1)

    // No second invoice, ever.
    equal(delta(before, readBackendSnapshot()).pos_invoices, 0)

    const queue = queueRow(context.database, seeded.queueUuid)
    equal(queue.state, 'conflict')
    ok(queue.last_error_code !== null)

    // Both sides are preserved for review; nothing is auto-resolved.
    equal(localCounts(context.database).sync_conflicts, 1)
    equal(localCounts(context.database).local_invoices, 1)
    equal(localCounts(context.database).sync_queue, 1)
    equal(invoiceRow(context.database, seeded.invoiceUuid).sync_status, 'conflict')
    equal(invoiceRow(context.database, seeded.invoiceUuid).remote_uuid, null)

    // A conflict is a question for a person: a further drain must not re-ask the server.
    await worker.run()
    equal(context.spy.uploadRequests().length, 1)

    context.close()
  }
)
