import { equal, deepEqual, ok, throws } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { isUploadLeaseExpired } from '../../../src/main/sync/syncPolicy'
import { InvoiceUploadOutcomeRecorder } from '../../../src/main/sync/invoiceUploadOutcome'
import { databaseTest } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'

const HASH_64 = 'a'.repeat(64)
const COMPANY = '11111111-1111-4111-8111-111111111111'
const DEVICE = '33333333-3333-4333-8333-333333333333'
const OTHER_DEVICE = '33333333-3333-4333-8333-3333333333ff'
const USER = '44444444-4444-4444-8444-444444444444'
const OWNER = { companyUuid: COMPANY, deviceUuid: DEVICE }

function uuid(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
}

/** A committed sale plus its one immutable invoice-upload queue row, exactly as Phase 3F leaves it. */
function seedQueuedInvoice(
  database: SqliteDatabase,
  repositories: RealRepositories,
  options: {
    readonly n: string
    readonly createdAt: string
    readonly deviceUuid?: string
    readonly companyUuid?: string
  }
): { readonly invoiceUuid: string; readonly queueUuid: string } {
  const invoiceUuid = uuid(`1${options.n}`)
  const queueUuid = uuid(`2${options.n}`)
  const attemptKey = uuid(`3${options.n}`)
  const companyUuid = options.companyUuid ?? COMPANY
  const deviceUuid = options.deviceUuid ?? DEVICE

  repositories.saleAttempts.claim({
    attemptKey,
    companyUuid,
    deviceUuid,
    userUuid: USER,
    claimSessionEpoch: 1,
    originShiftUuid: uuid('9'),
    originShiftObservedAt: options.createdAt,
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
    offlineNumber: `POS-000001-20260902-00000${options.n}`,
    companyUuid,
    branchUuid: uuid('8'),
    warehouseUuid: uuid('7'),
    deviceUuid,
    userUuid: USER,
    shiftUuid: uuid('9'),
    commitSessionEpoch: 1,
    catalogRevision: HASH_64,
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
    soldAt: options.createdAt,
    connectivityStateAtSale: 'online',
    soldWhileOffline: false,
    notes: null,
    commercialSnapshotJson: '{}',
    createdAt: options.createdAt
  })

  repositories.saleAttempts.markCommitted(attemptKey, invoiceUuid, options.createdAt)

  repositories.syncQueue.enqueue({
    localQueueUuid: queueUuid,
    aggregateType: 'invoice',
    localAggregateUuid: invoiceUuid,
    operation: 'upload',
    payloadJson: `{"idempotency_key":"${invoiceUuid}"}`,
    payloadHash: HASH_64,
    idempotencyKey: invoiceUuid
  })

  // enqueue() stamps created_at from the wall clock. Backdate it to the sale's own time so the
  // drain-order test can seed rows hours apart instead of milliseconds apart.
  database
    .prepare('UPDATE sync_queue SET created_at = ?, updated_at = ? WHERE local_queue_uuid = ?')
    .run(options.createdAt, options.createdAt, queueUuid)

  return { invoiceUuid, queueUuid }
}

databaseTest('an invoice upload is claimed, leased, and marked synced atomically', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { invoiceUuid, queueUuid } = seedQueuedInvoice(database, repositories, {
    n: '1',
    createdAt: '2026-09-02T10:00:00.000Z'
  })

  const claimed = repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T10:05:00.000Z')
  ok(claimed !== null)
  equal(claimed.localQueueUuid, queueUuid)
  equal(claimed.invoiceLocalUuid, invoiceUuid)
  equal(claimed.idempotencyKey, invoiceUuid)
  equal(claimed.attemptCount, 1)

  // Claiming leases the row and moves the invoice in lockstep, so nothing else can pick it up.
  equal(repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T10:05:01.000Z'), null)

  const recorder = new InvoiceUploadOutcomeRecorder({
    database,
    syncQueue: repositories.syncQueue,
    localSale: repositories.localSale,
    syncConflicts: repositories.syncConflicts,
    now: () => '2026-09-02T10:06:00.000Z'
  })
  recorder.record(claimed, {
    kind: 'synced',
    remoteUuid: uuid('aa'),
    serverNumber: 'POS-20260902-000042'
  })

  closeDatabase(database)

  const queueRow = readCommitted<{
    state: string
    upload_lease_at: string | null
    attempt_count: number
  }>(
    sandbox,
    'SELECT state, upload_lease_at, attempt_count FROM sync_queue WHERE local_queue_uuid = ?',
    [queueUuid]
  )[0]
  equal(queueRow?.state, 'synced')
  equal(queueRow?.upload_lease_at, null)
  equal(queueRow?.attempt_count, 1)

  const invoiceRow = readCommitted<{
    sync_status: string
    remote_uuid: string | null
    server_number: string | null
    synced_at: string | null
    sync_attempts: number
  }>(
    sandbox,
    'SELECT sync_status, remote_uuid, server_number, synced_at, sync_attempts FROM local_invoices WHERE local_uuid = ?',
    [invoiceUuid]
  )[0]
  equal(invoiceRow?.sync_status, 'synced')
  equal(invoiceRow?.remote_uuid, uuid('aa'))
  equal(invoiceRow?.server_number, 'POS-20260902-000042')
  equal(invoiceRow?.synced_at, '2026-09-02T10:06:00.000Z')
  equal(invoiceRow?.sync_attempts, 1)
})

databaseTest('a duplicate answer resolves exactly like a fresh commit', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { invoiceUuid } = seedQueuedInvoice(database, repositories, {
    n: '1',
    createdAt: '2026-09-02T10:00:00.000Z'
  })

  const claimed = repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T10:05:00.000Z')
  ok(claimed !== null)

  // The worker maps 200 DESKTOP_INVOICE_ALREADY_UPLOADED to the same 'synced' outcome; the server
  // holds one invoice either way, so the local record must converge, not stay stuck.
  new InvoiceUploadOutcomeRecorder({
    database,
    syncQueue: repositories.syncQueue,
    localSale: repositories.localSale,
    syncConflicts: repositories.syncConflicts,
    now: () => '2026-09-02T10:06:00.000Z'
  }).record(claimed, {
    kind: 'synced',
    remoteUuid: uuid('bb'),
    serverNumber: 'POS-20260902-000007'
  })

  closeDatabase(database)

  equal(
    readCommitted<{ sync_status: string }>(
      sandbox,
      'SELECT sync_status FROM local_invoices WHERE local_uuid = ?',
      [invoiceUuid]
    )[0]?.sync_status,
    'synced'
  )
  equal(
    readCommitted<{ count: number }>(sandbox, 'SELECT COUNT(*) AS count FROM sync_queue', [])[0]
      ?.count,
    1
  )
})

databaseTest('a conflict is terminal, preserved for review, and never rescheduled', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { invoiceUuid, queueUuid } = seedQueuedInvoice(database, repositories, {
    n: '1',
    createdAt: '2026-09-02T10:00:00.000Z'
  })

  const claimed = repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T10:05:00.000Z')
  ok(claimed !== null)

  new InvoiceUploadOutcomeRecorder({
    database,
    syncQueue: repositories.syncQueue,
    localSale: repositories.localSale,
    syncConflicts: repositories.syncConflicts,
    now: () => '2026-09-02T10:06:00.000Z'
  }).record(claimed, {
    kind: 'conflict',
    errorCode: 'IDEMPOTENCY_CONFLICT',
    details: { backendCode: 'IDEMPOTENCY_CONFLICT', httpStatus: 409, traceId: 'trace-5' },
    reportedDetails: 'This idempotency key was already used with a different payload.'
  })

  // Terminal states never carry a retry deadline, so no scheduler can wake them by accident.
  const queueRow = readCommitted<{
    state: string
    next_attempt_at: string | null
    last_error_code: string | null
    last_error_details: string | null
  }>(
    sandbox,
    'SELECT state, next_attempt_at, last_error_code, last_error_details FROM sync_queue WHERE local_queue_uuid = ?',
    [queueUuid]
  )[0]
  equal(queueRow?.state, 'conflict')
  equal(queueRow?.next_attempt_at, null)
  equal(queueRow?.last_error_code, 'IDEMPOTENCY_CONFLICT')
  deepEqual(JSON.parse(queueRow?.last_error_details ?? '{}'), {
    backendCode: 'IDEMPOTENCY_CONFLICT',
    httpStatus: 409,
    traceId: 'trace-5'
  })

  const conflict = readCommitted<{
    conflict_code: string
    local_payload_json: string
    reported_details: string | null
  }>(
    sandbox,
    'SELECT conflict_code, local_payload_json, reported_details FROM sync_conflicts WHERE local_queue_uuid = ?',
    [queueUuid]
  )[0]
  equal(conflict?.conflict_code, 'IDEMPOTENCY_CONFLICT')
  equal(conflict?.local_payload_json, `{"idempotency_key":"${invoiceUuid}"}`)
  ok(conflict?.reported_details?.includes('already used with a different payload'))

  // The sale itself is untouched: no server identity is claimed, and nothing is negated.
  const invoiceRow = readCommitted<{
    sync_status: string
    remote_uuid: string | null
    synced_at: string | null
  }>(
    sandbox,
    'SELECT sync_status, remote_uuid, synced_at FROM local_invoices WHERE local_uuid = ?',
    [invoiceUuid]
  )[0]
  equal(invoiceRow?.sync_status, 'conflict')
  equal(invoiceRow?.remote_uuid, null)
  equal(invoiceRow?.synced_at, null)

  closeDatabase(database)
})

databaseTest('a transient failure backs off and only then becomes claimable again', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  seedQueuedInvoice(database, repositories, { n: '1', createdAt: '2026-09-02T10:00:00.000Z' })

  const claimed = repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T10:05:00.000Z')
  ok(claimed !== null)

  new InvoiceUploadOutcomeRecorder({
    database,
    syncQueue: repositories.syncQueue,
    localSale: repositories.localSale,
    syncConflicts: repositories.syncConflicts,
    now: () => '2026-09-02T10:05:00.000Z'
  }).record(claimed, {
    kind: 'retryable',
    errorCode: 'transport_failure',
    retryDelayMs: 60_000
  })

  // Still in backoff: releasing does nothing and the row stays unclaimable.
  deepEqual(repositories.syncQueue.releaseDueRetries('2026-09-02T10:05:30.000Z'), [])
  equal(repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T10:05:30.000Z'), null)

  // Past the deadline it returns to pending and the next claim increments the attempt count.
  equal(repositories.syncQueue.releaseDueRetries('2026-09-02T10:06:01.000Z').length, 1)
  const second = repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T10:06:02.000Z')
  ok(second !== null)
  equal(second.attemptCount, 2)
  equal(second.idempotencyKey, claimed.idempotencyKey)

  closeDatabase(database)
})

databaseTest('an upload lease orphaned by a crash is reclaimed, not lost', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { queueUuid } = seedQueuedInvoice(database, repositories, {
    n: '1',
    createdAt: '2026-09-02T10:00:00.000Z'
  })

  const claimed = repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T10:05:00.000Z')
  ok(claimed !== null)

  // A fresh lease is not reclaimable.
  deepEqual(
    repositories.syncQueue.reclaimExpiredUploadLeases('2026-09-02T10:05:10.000Z', (leaseAt, now) =>
      isUploadLeaseExpired(leaseAt, now)
    ),
    []
  )

  // An expired one goes to retryable_error — `uploading -> pending` is not a legal transition, and
  // "the dispatch did not finish" is what actually happened.
  deepEqual(
    repositories.syncQueue.reclaimExpiredUploadLeases('2026-09-02T10:10:00.000Z', (leaseAt, now) =>
      isUploadLeaseExpired(leaseAt, now)
    ),
    [queueUuid]
  )
  const reclaimedRow = database
    .prepare('SELECT state, last_error_code FROM sync_queue WHERE local_queue_uuid = ?')
    .get(queueUuid) as { state: string; last_error_code: string | null }
  equal(reclaimedRow.state, 'retryable_error')
  equal(reclaimedRow.last_error_code, 'upload_lease_expired')

  // It becomes claimable again under the same idempotency key.
  equal(repositories.syncQueue.releaseDueRetries('2026-09-02T10:10:01.000Z').length, 1)
  const retried = repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T10:10:02.000Z')
  ok(retried !== null && retried.idempotencyKey === claimed.idempotencyKey)

  closeDatabase(database)
})

databaseTest('claims are owner-scoped in SQL and ordered deterministically', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)

  // Seeded out of chronological order on purpose: the drain order must come from created_at, not
  // from insertion or physical row order.
  seedQueuedInvoice(database, repositories, { n: '2', createdAt: '2026-09-02T12:00:00.000Z' })
  seedQueuedInvoice(database, repositories, { n: '1', createdAt: '2026-09-02T09:00:00.000Z' })
  const foreign = seedQueuedInvoice(database, repositories, {
    n: '3',
    createdAt: '2026-09-02T08:00:00.000Z',
    deviceUuid: OTHER_DEVICE
  })

  const first = repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T13:00:00.000Z')
  ok(first !== null)
  equal(first.invoiceLocalUuid, uuid('11'))

  // The foreign row is older than both, and is still never selected.
  ok(first.localQueueUuid !== foreign.queueUuid)
  equal(repositories.syncQueue.countForeignPendingUploads(OWNER), 1)

  closeDatabase(database)
})

databaseTest('the schema refuses a staged or partial success write', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { invoiceUuid } = seedQueuedInvoice(database, repositories, {
    n: '1',
    createdAt: '2026-09-02T10:00:00.000Z'
  })

  // remote_uuid without sync_status='synced' violates the 0007 CHECK...
  throws(() =>
    database
      .prepare('UPDATE local_invoices SET remote_uuid = ? WHERE local_uuid = ?')
      .run(uuid('aa'), invoiceUuid)
  )

  // ...and so does 'synced' without synced_at.
  throws(() =>
    database
      .prepare('UPDATE local_invoices SET sync_status = ? WHERE local_uuid = ?')
      .run('synced', invoiceUuid)
  )

  // A failure writer must never claim a server identity.
  repositories.localSale.markInvoiceUploadFailed(invoiceUuid, {
    syncStatus: 'rejected',
    lastSyncError: 'DESKTOP_ALLOCATION_PROOF_REQUIRED',
    updatedAt: '2026-09-02T10:06:00.000Z'
  })
  const row = repositories.localSale.findInvoiceByLocalUuid(invoiceUuid)
  ok(row !== null && row.remoteUuid === null && row.syncedAt === null)
  equal(row.syncStatus, 'rejected')

  closeDatabase(database)
})

databaseTest('getStatus reports counts, and a pause only when the worker says so', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  seedQueuedInvoice(database, repositories, { n: '1', createdAt: '2026-09-02T10:00:00.000Z' })
  seedQueuedInvoice(database, repositories, { n: '2', createdAt: '2026-09-02T11:00:00.000Z' })
  repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T12:00:00.000Z')

  const idle = repositories.syncQueue.getStatus()
  equal(idle.state, 'idle')
  equal(idle.pausedReason, null)
  equal(idle.counts.pending, 1)
  equal(idle.counts.uploading, 1)

  // The pause is the worker's in-memory fact, never a persisted seventh state.
  const paused = repositories.syncQueue.getStatus('license-denied')
  equal(paused.state, 'paused')
  equal(paused.pausedReason, 'license-denied')
  equal(paused.counts.pending, 1)

  closeDatabase(database)
})

databaseTest('a terminal rejection preserves the sale and refuses to be retried', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { invoiceUuid, queueUuid } = seedQueuedInvoice(database, repositories, {
    n: '1',
    createdAt: '2026-09-02T10:00:00.000Z'
  })

  const claimed = repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-02T10:05:00.000Z')
  ok(claimed !== null)

  new InvoiceUploadOutcomeRecorder({
    database,
    syncQueue: repositories.syncQueue,
    localSale: repositories.localSale,
    syncConflicts: repositories.syncConflicts,
    now: () => '2026-09-02T10:06:00.000Z'
  }).record(claimed, {
    kind: 'rejected',
    errorCode: 'DESKTOP_CATALOG_REVISION_INVALID',
    details: { httpStatus: 422, message: 'The catalog revision is no longer valid.' }
  })

  // Terminal: neither the backoff release nor a fresh claim can resurrect it.
  deepEqual(repositories.syncQueue.releaseDueRetries('2026-09-03T10:00:00.000Z'), [])
  equal(repositories.syncQueue.claimNextInvoiceUpload(OWNER, '2026-09-03T10:00:00.000Z'), null)

  // No conflict row: a rejection is not a disagreement about payloads.
  equal(
    (database.prepare('SELECT COUNT(*) AS count FROM sync_conflicts').get() as { count: number })
      .count,
    0
  )

  // The sale itself survives intact — the server refused the upload, not the sale.
  const invoice = repositories.localSale.findInvoiceByLocalUuid(invoiceUuid)
  ok(invoice !== null)
  equal(invoice.syncStatus, 'rejected')
  equal(invoice.grandTotalAmount, 1000)
  equal(
    invoice.lastSyncError,
    'DESKTOP_CATALOG_REVISION_INVALID: The catalog revision is no longer valid.'
  )
  equal(
    (
      database
        .prepare('SELECT COUNT(*) AS count FROM sync_queue WHERE local_queue_uuid = ?')
        .get(queueUuid) as { count: number }
    ).count,
    1
  )

  closeDatabase(database)
})

databaseTest('an outcome cannot be recorded against a row that is not uploading', (sandbox) => {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const { invoiceUuid, queueUuid } = seedQueuedInvoice(database, repositories, {
    n: '1',
    createdAt: '2026-09-02T10:00:00.000Z'
  })

  // The row is still pending: writing an outcome onto it would be recording an answer to a
  // request that was never dispatched.
  throws(
    () => repositories.syncQueue.markUploadSynced(queueUuid, '2026-09-02T10:06:00.000Z'),
    /is pending, not uploading/
  )
  throws(
    () =>
      repositories.syncQueue.failUpload(queueUuid, 'rejected', '2026-09-02T10:06:00.000Z', {
        errorCode: 'VALIDATION_ERROR'
      }),
    /is pending, not uploading/
  )
  throws(
    () => repositories.syncQueue.markUploadSynced(uuid('ff'), '2026-09-02T10:06:00.000Z'),
    /was not found/
  )

  const untouched = repositories.localSale.findInvoiceByLocalUuid(invoiceUuid)
  ok(untouched !== null && untouched.syncStatus === 'pending')

  closeDatabase(database)
})
