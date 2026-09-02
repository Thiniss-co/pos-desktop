import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'

const HASH_64 = 'a'.repeat(64)
const COMPANY = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY = '11111111-1111-4111-8111-1111111111ff'
const DEVICE = '33333333-3333-4333-8333-333333333333'
const OTHER_DEVICE = '33333333-3333-4333-8333-3333333333ff'
const USER = '44444444-4444-4444-8444-444444444444'
const OTHER_USER = '44444444-4444-4444-8444-4444444444ff'
const OWNER = { companyUuid: COMPANY, deviceUuid: DEVICE }

function uuid(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
}

/** A committed sale plus its queue row, driven to a terminal state. */
function seedFailure(
  database: SqliteDatabase,
  repositories: RealRepositories,
  options: {
    readonly n: string
    readonly createdAt: string
    readonly state: 'conflict' | 'rejected' | 'synced' | 'retryable_error' | 'leave-pending'
    readonly companyUuid?: string
    readonly deviceUuid?: string
    readonly userUuid?: string
    readonly errorCode?: string
    readonly traceId?: string
    readonly message?: string
    readonly queueUuid?: string
  }
): { readonly invoiceUuid: string; readonly queueUuid: string } {
  const invoiceUuid = uuid(`1${options.n}`)
  const queueUuid = options.queueUuid ?? uuid(`2${options.n}`)
  const attemptKey = uuid(`3${options.n}`)
  const companyUuid = options.companyUuid ?? COMPANY
  const deviceUuid = options.deviceUuid ?? DEVICE

  repositories.saleAttempts.claim({
    attemptKey,
    companyUuid,
    deviceUuid,
    userUuid: options.userUuid ?? USER,
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
    offlineNumber: `POS-000001-20260903-0000${options.n.padStart(2, '0')}`,
    companyUuid,
    branchUuid: uuid('8'),
    warehouseUuid: uuid('7'),
    deviceUuid,
    userUuid: options.userUuid ?? USER,
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

  database
    .prepare('UPDATE sync_queue SET created_at = ?, updated_at = ? WHERE local_queue_uuid = ?')
    .run(options.createdAt, options.createdAt, queueUuid)

  if (options.state === 'leave-pending') {
    return { invoiceUuid, queueUuid }
  }

  // Drive *this* row, not whichever row happens to be oldest: claimNextInvoiceUpload is FIFO, so
  // using it here would silently seed the wrong row once a test leaves a pending one behind.
  repositories.syncQueue.transition(queueUuid, 'uploading')

  if (options.state === 'synced') {
    repositories.syncQueue.markUploadSynced(queueUuid, options.createdAt)
  } else {
    repositories.syncQueue.failUpload(queueUuid, options.state, options.createdAt, {
      errorCode: options.errorCode ?? 'IDEMPOTENCY_CONFLICT',
      details: {
        backendCode: options.errorCode ?? 'IDEMPOTENCY_CONFLICT',
        httpStatus: 409,
        traceId: options.traceId ?? `trace-${options.n}`,
        message: options.message ?? 'The server already holds a different invoice for this key.'
      }
    })
  }

  return { invoiceUuid, queueUuid }
}

databaseTest('the failure list returns only terminal conflict and rejected rows', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)

    seedFailure(database, repositories, {
      n: '1',
      createdAt: '2026-09-03T10:00:00.000Z',
      state: 'conflict'
    })
    seedFailure(database, repositories, {
      n: '2',
      createdAt: '2026-09-03T10:01:00.000Z',
      state: 'rejected',
      errorCode: 'DESKTOP_ALLOCATION_PROOF_REQUIRED'
    })
    // Excluded: still in play, or already succeeded.
    seedFailure(database, repositories, {
      n: '3',
      createdAt: '2026-09-03T10:02:00.000Z',
      state: 'leave-pending'
    })
    seedFailure(database, repositories, {
      n: '4',
      createdAt: '2026-09-03T10:03:00.000Z',
      state: 'retryable_error'
    })
    seedFailure(database, repositories, {
      n: '5',
      createdAt: '2026-09-03T10:04:00.000Z',
      state: 'synced'
    })

    const page = repositories.syncQueue.listUploadFailures(OWNER)

    equal(page.items.length, 2)
    deepEqual(
      page.items.map((item) => item.state),
      ['conflict', 'rejected']
    )
    equal(page.nextCursor, null)

    const [conflict] = page.items
    equal(conflict.backendCode, 'IDEMPOTENCY_CONFLICT')
    equal(conflict.traceId, 'trace-1')
    equal(conflict.totalAmount, 1000)
    equal(conflict.currency, 'USD')
    equal(conflict.currencyExponent, 2)
    equal(conflict.cashierUuid, USER)
    equal(conflict.shiftUuid, uuid('9'))
    ok(conflict.offlineNumber !== null)
    // The frozen request payload never crosses this seam.
    ok(!Object.prototype.hasOwnProperty.call(conflict, 'payloadJson'))
    ok(!Object.prototype.hasOwnProperty.call(conflict, 'idempotencyKey'))
  } finally {
    closeDatabase(database)
  }
})

databaseTest('the failure list is scoped to the owning company and device in SQL', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)

    seedFailure(database, repositories, {
      n: '1',
      createdAt: '2026-09-03T10:00:00.000Z',
      state: 'conflict'
    })
    seedFailure(database, repositories, {
      n: '2',
      createdAt: '2026-09-03T10:01:00.000Z',
      state: 'rejected',
      deviceUuid: OTHER_DEVICE
    })
    seedFailure(database, repositories, {
      n: '3',
      createdAt: '2026-09-03T10:02:00.000Z',
      state: 'conflict',
      companyUuid: OTHER_COMPANY
    })

    const page = repositories.syncQueue.listUploadFailures(OWNER)

    equal(page.items.length, 1)
    equal(page.items[0].localQueueUuid, uuid('21'))

    // Another till's and another company's failures are unreachable, not merely unselected.
    equal(
      repositories.syncQueue.listUploadFailures({ companyUuid: COMPANY, deviceUuid: OTHER_DEVICE })
        .items.length,
      1
    )
    equal(
      repositories.syncQueue.listUploadFailures({
        companyUuid: OTHER_COMPANY,
        deviceUuid: OTHER_DEVICE
      }).items.length,
      0
    )
  } finally {
    closeDatabase(database)
  }
})

databaseTest('a colleague’s failed sale on the same till stays visible', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)

    seedFailure(database, repositories, {
      n: '1',
      createdAt: '2026-09-03T10:00:00.000Z',
      state: 'rejected',
      userUuid: OTHER_USER
    })

    // Upload is device-owned and the backend attributes it from the immutable shift, so cross-user
    // rows on this device are exactly what this operator must be able to review.
    const page = repositories.syncQueue.listUploadFailures(OWNER)

    equal(page.items.length, 1)
    equal(page.items[0].cashierUuid, OTHER_USER)
  } finally {
    closeDatabase(database)
  }
})

databaseTest('failures are ordered by queue time regardless of insertion order', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)

    seedFailure(database, repositories, {
      n: '3',
      createdAt: '2026-09-03T12:00:00.000Z',
      state: 'conflict'
    })
    seedFailure(database, repositories, {
      n: '1',
      createdAt: '2026-09-03T10:00:00.000Z',
      state: 'rejected'
    })
    seedFailure(database, repositories, {
      n: '2',
      createdAt: '2026-09-03T11:00:00.000Z',
      state: 'conflict'
    })

    const page = repositories.syncQueue.listUploadFailures(OWNER)

    deepEqual(
      page.items.map((item) => item.queuedAt),
      ['2026-09-03T10:00:00.000Z', '2026-09-03T11:00:00.000Z', '2026-09-03T12:00:00.000Z']
    )
  } finally {
    closeDatabase(database)
  }
})

databaseTest('an exact timestamp tie is broken by local_queue_uuid', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)
    const sameInstant = '2026-09-03T10:00:00.000Z'

    seedFailure(database, repositories, {
      n: '2',
      createdAt: sameInstant,
      state: 'conflict',
      queueUuid: uuid('bb')
    })
    seedFailure(database, repositories, {
      n: '1',
      createdAt: sameInstant,
      state: 'conflict',
      queueUuid: uuid('aa')
    })

    const page = repositories.syncQueue.listUploadFailures(OWNER)

    deepEqual(
      page.items.map((item) => item.localQueueUuid),
      [uuid('aa'), uuid('bb')]
    )
  } finally {
    closeDatabase(database)
  }
})

databaseTest('multi-page traversal yields every row exactly once', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)

    for (let index = 1; index <= 5; index += 1) {
      seedFailure(database, repositories, {
        n: String(index),
        createdAt: `2026-09-03T10:0${index}:00.000Z`,
        state: index % 2 === 0 ? 'rejected' : 'conflict'
      })
    }

    const seen: string[] = []
    let cursor = null as ReturnType<typeof repositories.syncQueue.listUploadFailures>['nextCursor']
    let pages = 0

    do {
      const page = repositories.syncQueue.listUploadFailures(OWNER, cursor, 2)
      pages += 1

      for (const item of page.items) {
        seen.push(item.localQueueUuid)
      }

      cursor = page.nextCursor
    } while (cursor !== null && pages < 10)

    equal(seen.length, 5)
    equal(new Set(seen).size, 5, 'no row is repeated across pages')
    deepEqual(seen, [uuid('21'), uuid('22'), uuid('23'), uuid('24'), uuid('25')])
  } finally {
    closeDatabase(database)
  }
})

databaseTest('a cursor from another device reveals nothing of that device', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)

    seedFailure(database, repositories, {
      n: '1',
      createdAt: '2026-09-03T10:00:00.000Z',
      state: 'conflict',
      deviceUuid: OTHER_DEVICE
    })
    seedFailure(database, repositories, {
      n: '2',
      createdAt: '2026-09-03T11:00:00.000Z',
      state: 'conflict'
    })

    // A well-formed cursor naming a foreign row is still evaluated inside this owner's scope: it can
    // only move the window forward, never widen it.
    const page = repositories.syncQueue.listUploadFailures(
      OWNER,
      { createdAt: '2026-09-03T10:00:00.000Z', localQueueUuid: uuid('21') },
      10
    )

    equal(page.items.length, 1)
    equal(page.items[0].localQueueUuid, uuid('22'))
  } finally {
    closeDatabase(database)
  }
})

databaseTest('the page size is clamped to the contract maximum', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)

    for (let index = 1; index <= 3; index += 1) {
      seedFailure(database, repositories, {
        n: String(index),
        createdAt: `2026-09-03T10:0${index}:00.000Z`,
        state: 'rejected'
      })
    }

    equal(repositories.syncQueue.listUploadFailures(OWNER, null, 1).items.length, 1)
    equal(repositories.syncQueue.listUploadFailures(OWNER, null, 10_000).items.length, 3)
    equal(repositories.syncQueue.listUploadFailures(OWNER, null, 0).items.length, 1)
  } finally {
    closeDatabase(database)
  }
})

databaseTest('listing failures writes nothing at all', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)

    seedFailure(database, repositories, {
      n: '1',
      createdAt: '2026-09-03T10:00:00.000Z',
      state: 'conflict'
    })

    const snapshot = (): string =>
      JSON.stringify({
        queue: database.prepare('SELECT * FROM sync_queue ORDER BY local_queue_uuid').all(),
        invoices: database.prepare('SELECT * FROM local_invoices ORDER BY local_uuid').all(),
        conflicts: database.prepare('SELECT * FROM sync_conflicts ORDER BY local_queue_uuid').all(),
        movements: database.prepare('SELECT * FROM local_stock_movements ORDER BY local_uuid').all()
      })

    const before = snapshot()
    repositories.syncQueue.listUploadFailures(OWNER)
    repositories.syncQueue.listUploadFailures(OWNER, null, 1)
    const after = snapshot()

    equal(after, before, 'reviewing a failure must never mutate, retry or acknowledge it')
  } finally {
    closeDatabase(database)
  }
})
