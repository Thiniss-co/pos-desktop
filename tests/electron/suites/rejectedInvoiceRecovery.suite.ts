import { equal, ok, throws } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import { isSyncQueueTransitionAllowed } from '../../../src/shared/constants/syncQueueStates'
import { payloadHash } from '../../../src/main/services/localSale.fingerprint'

/**
 * PS8 — the bounded recovery path for one terminally-rejected invoice upload.
 *
 * The incident these tests are shaped around is `POS-235a06-20260914-000003`: a legitimate,
 * committed, paid-for service sale whose upload the backend refused for a rule it no longer has.
 * Now that the server accepts it, the sale must be re-offerable — under its ORIGINAL identity, by a
 * deliberate act, and without weakening the rule that terminal means terminal for everything
 * automatic.
 *
 * Every test here therefore asserts one of two things: that the narrow, fully-identified re-offer
 * works, or that some *adjacent* thing still does not.
 */

const HASH_64 = 'a'.repeat(64)
const COMPANY = '11111111-1111-4111-8111-111111111111'
const DEVICE = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const OWNER = { companyUuid: COMPANY, deviceUuid: DEVICE }

function uuid(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
}

/**
 * The incident's own frozen payload shape: a v3 physical-presence body whose single line is an
 * untracked service — no `stock_authorization`, no `allocations`.
 */
function frozenServicePayload(invoiceUuid: string): Record<string, unknown> {
  return {
    idempotency_key: invoiceUuid,
    local_invoice_uuid: invoiceUuid,
    catalog_revision: HASH_64,
    offline_number: 'POS-235a06-20260914-000003',
    sold_at: '2026-09-14T12:32:04.731Z',
    sold_while_offline: true,
    customer_uuid: null,
    currency: 'SAR',
    tax_mode: 'none',
    client_contract_version: 3,
    shift_uuid: uuid('9'),
    offline_sale_authority_uuid: uuid('a'),
    items: [
      {
        product_uuid: uuid('b'),
        barcode: '2000000000039',
        quantity: '1.000',
        unit_price_amount: 500,
        currency: 'SAR',
        price_revision: HASH_64,
        tax_id: null,
        tax_mode: 'none',
        tax_rate_basis_points: 0,
        tax_revision: HASH_64,
        discount_type: null,
        discount_value: 0
      }
    ],
    invoice_discount: { type: null, value: 0 },
    payments: [
      {
        payment_method_uuid: uuid('c'),
        type: 'cash',
        amount: 500,
        reference: null,
        paid_at: '2026-09-14T12:32:04.731Z'
      }
    ],
    notes: null
  }
}

interface Seeded {
  readonly invoiceUuid: string
  readonly queueUuid: string
  readonly payloadJson: string
  readonly payloadHash: string
}

function seedRejectedServiceSale(
  repositories: RealRepositories,
  options: {
    readonly n: string
    readonly state: 'rejected' | 'conflict' | 'retryable_error' | 'synced' | 'leave-pending'
    readonly errorCode?: string
  }
): Seeded {
  const createdAt = '2026-09-14T12:32:04.733Z'
  const invoiceUuid = uuid(`1${options.n}`)
  const queueUuid = uuid(`2${options.n}`)
  const attemptKey = uuid(`3${options.n}`)
  const payload = frozenServicePayload(invoiceUuid)
  const payloadJson = JSON.stringify(payload)
  const hash = payloadHash(payload)

  repositories.saleAttempts.claim({
    attemptKey,
    companyUuid: COMPANY,
    deviceUuid: DEVICE,
    userUuid: USER,
    claimSessionEpoch: 1,
    originShiftUuid: uuid('9'),
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
    offlineNumber: `POS-235a06-20260914-00000${options.n}`,
    companyUuid: COMPANY,
    branchUuid: uuid('8'),
    warehouseUuid: uuid('7'),
    deviceUuid: DEVICE,
    userUuid: USER,
    shiftUuid: uuid('9'),
    commitSessionEpoch: 1,
    catalogRevision: HASH_64,
    intentFingerprint: HASH_64,
    customerUuid: null,
    currency: 'SAR',
    currencyExponent: 2,
    taxMode: 'none',
    invoiceDiscountType: null,
    invoiceDiscountValue: 0,
    subtotalAmount: 500,
    discountTotalAmount: 0,
    taxTotalAmount: 0,
    grandTotalAmount: 500,
    paidTotalAmount: 500,
    changeDueAmount: 0,
    soldAt: '2026-09-14T12:32:04.731Z',
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
    payloadHash: hash,
    idempotencyKey: invoiceUuid
  })

  if (options.state !== 'leave-pending') {
    repositories.syncQueue.transition(queueUuid, 'uploading')

    if (options.state === 'synced') {
      repositories.syncQueue.markUploadSynced(queueUuid, createdAt)
      repositories.localSale.markInvoiceSynced(invoiceUuid, {
        remoteUuid: uuid('f'),
        serverNumber: 'INV-1',
        syncedAt: createdAt
      })
    } else {
      const code = options.errorCode ?? 'VALIDATION_ERROR'
      repositories.syncQueue.failUpload(queueUuid, options.state, createdAt, {
        errorCode: code,
        details: {
          backendCode: code,
          httpStatus: 422,
          traceId: '03878247-3964-4517-bb93-54daf956981f',
          message: 'The given data was invalid.'
        }
      })
      repositories.localSale.markInvoiceUploadFailed(invoiceUuid, {
        syncStatus: options.state,
        lastSyncError: `${code}: The given data was invalid.`,
        updatedAt: createdAt
      })
    }
  }

  return { invoiceUuid, queueUuid, payloadJson, payloadHash: hash }
}

function queueRow(
  database: SqliteDatabase,
  queueUuid: string
): {
  readonly state: string
  readonly payload_json: string
  readonly payload_hash: string
  readonly idempotency_key: string
  readonly attempt_count: number
  readonly last_error_code: string | null
  readonly next_attempt_at: string | null
  readonly upload_lease_at: string | null
} {
  return database
    .prepare(
      `SELECT state, payload_json, payload_hash, idempotency_key, attempt_count, last_error_code,
              next_attempt_at, upload_lease_at
         FROM sync_queue WHERE local_queue_uuid = ?`
    )
    .get(queueUuid) as never
}

databaseTest(
  'the terminal state machine still forbids rejected -> pending for everything automatic',
  () => {
    // The guarantee this recovery path must NOT weaken: no worker, reconciler or startup sweep can
    // move a rejected row, because the transition simply is not in the map.
    equal(isSyncQueueTransitionAllowed('rejected', 'pending'), false)
    equal(isSyncQueueTransitionAllowed('conflict', 'pending'), false)
    equal(isSyncQueueTransitionAllowed('synced', 'pending'), false)
    equal(isSyncQueueTransitionAllowed('retryable_error', 'pending'), true)
  }
)

databaseTest(
  'a fully identified rejected upload is re-offered under its original identity',
  (sandbox) => {
    const database = openTestDatabase(sandbox)

    try {
      const repositories = realRepositories(database)
      const seeded = seedRejectedServiceSale(repositories, { n: '1', state: 'rejected' })

      const before = queueRow(database, seeded.queueUuid)
      equal(before.state, 'rejected')

      const requeued = repositories.syncQueue.requeueRejectedUpload(seeded.invoiceUuid, {
        idempotencyKey: seeded.invoiceUuid,
        payloadHash: seeded.payloadHash
      })

      equal(requeued, true)

      const after = queueRow(database, seeded.queueUuid)

      equal(after.state, 'pending')
      // The frozen evidence is byte-identical: same payload, same hash, same key, same attempt count.
      equal(after.payload_json, seeded.payloadJson)
      equal(after.payload_hash, before.payload_hash)
      equal(after.idempotency_key, before.idempotency_key)
      equal(after.attempt_count, before.attempt_count)
      // The server's own account of the refusal is preserved for review beside the retry.
      equal(after.last_error_code, 'VALIDATION_ERROR')
      // Nothing is scheduled or leased: the ordinary worker claims it like any pending row.
      equal(after.next_attempt_at, null)
      equal(after.upload_lease_at, null)

      const invoice = repositories.localSale.findInvoiceByLocalUuid(seeded.invoiceUuid)
      ok(invoice !== null)
      equal(invoice.syncStatus, 'pending')
      // Never marked synced by hand: no server identity is claimed by a local recovery.
      equal(invoice.remoteUuid, null)
      equal(invoice.serverNumber, null)
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest('a re-offered upload becomes claimable by the ordinary worker', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)
    const seeded = seedRejectedServiceSale(repositories, { n: '1', state: 'rejected' })

    // Before: terminal, and invisible to the dispatcher.
    equal(repositories.syncQueue.claimNextInvoiceUpload(OWNER), null)

    repositories.syncQueue.requeueRejectedUpload(seeded.invoiceUuid, {
      idempotencyKey: seeded.invoiceUuid,
      payloadHash: seeded.payloadHash
    })

    const claimed = repositories.syncQueue.claimNextInvoiceUpload(OWNER)

    ok(claimed !== null)
    equal(claimed.localQueueUuid, seeded.queueUuid)
    equal(claimed.invoiceLocalUuid, seeded.invoiceUuid)
    // The bytes the worker will send are the bytes that were frozen at checkout.
    equal(claimed.payloadJson, seeded.payloadJson)
    equal(claimed.idempotencyKey, seeded.invoiceUuid)
  } finally {
    closeDatabase(database)
  }
})

databaseTest('a re-offered upload that succeeds resolves exactly once', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)
    const seeded = seedRejectedServiceSale(repositories, { n: '1', state: 'rejected' })

    repositories.syncQueue.requeueRejectedUpload(seeded.invoiceUuid, {
      idempotencyKey: seeded.invoiceUuid,
      payloadHash: seeded.payloadHash
    })

    const claimed = repositories.syncQueue.claimNextInvoiceUpload(OWNER)
    ok(claimed !== null)

    // The acknowledgment path is the ordinary one — this is what a 201 or a 200 duplicate both do.
    repositories.syncQueue.markUploadSynced(claimed.localQueueUuid, '2026-09-20T09:00:00.000Z')
    repositories.localSale.markInvoiceSynced(seeded.invoiceUuid, {
      remoteUuid: uuid('e'),
      serverNumber: 'INV-2026-000041',
      syncedAt: '2026-09-20T09:00:00.000Z'
    })

    equal(queueRow(database, seeded.queueUuid).state, 'synced')

    const invoice = repositories.localSale.findInvoiceByLocalUuid(seeded.invoiceUuid)
    ok(invoice !== null)
    equal(invoice.syncStatus, 'synced')
    equal(invoice.serverNumber, 'INV-2026-000041')

    // A second re-offer of a now-synced row does nothing: the guard is on `state = 'rejected'`.
    equal(
      repositories.syncQueue.requeueRejectedUpload(seeded.invoiceUuid, {
        idempotencyKey: seeded.invoiceUuid,
        payloadHash: seeded.payloadHash
      }),
      false
    )
    equal(queueRow(database, seeded.queueUuid).state, 'synced')

    // Exactly one queue row for this invoice throughout: no duplicate upload was ever created.
    equal(repositories.syncQueue.invoiceUploadRowsFor(seeded.invoiceUuid).length, 1)
  } finally {
    closeDatabase(database)
  }
})

databaseTest('the re-offer refuses every identity mismatch and writes nothing', (sandbox) => {
  const database = openTestDatabase(sandbox)

  try {
    const repositories = realRepositories(database)
    const seeded = seedRejectedServiceSale(repositories, { n: '1', state: 'rejected' })

    // Wrong idempotency key.
    equal(
      repositories.syncQueue.requeueRejectedUpload(seeded.invoiceUuid, {
        idempotencyKey: uuid('dead'),
        payloadHash: seeded.payloadHash
      }),
      false
    )

    // Wrong payload hash — the operator reviewed different bytes than the ones on disk.
    equal(
      repositories.syncQueue.requeueRejectedUpload(seeded.invoiceUuid, {
        idempotencyKey: seeded.invoiceUuid,
        payloadHash: 'f'.repeat(64)
      }),
      false
    )

    // An invoice that has no queued upload at all.
    equal(
      repositories.syncQueue.requeueRejectedUpload(uuid('beef'), {
        idempotencyKey: seeded.invoiceUuid,
        payloadHash: seeded.payloadHash
      }),
      false
    )

    equal(queueRow(database, seeded.queueUuid).state, 'rejected')
    equal(repositories.localSale.findInvoiceByLocalUuid(seeded.invoiceUuid)?.syncStatus, 'rejected')
  } finally {
    closeDatabase(database)
  }
})

databaseTest(
  'only a rejected row is re-offered — conflict, pending and synced are left alone',
  (sandbox) => {
    const database = openTestDatabase(sandbox)

    try {
      const repositories = realRepositories(database)

      // A conflict is a genuine disagreement for a person to resolve, never something to re-send.
      const conflict = seedRejectedServiceSale(repositories, {
        n: '2',
        state: 'conflict',
        errorCode: 'IDEMPOTENCY_CONFLICT'
      })
      const pending = seedRejectedServiceSale(repositories, { n: '3', state: 'leave-pending' })
      const retryable = seedRejectedServiceSale(repositories, { n: '4', state: 'retryable_error' })
      const synced = seedRejectedServiceSale(repositories, { n: '5', state: 'synced' })

      for (const seeded of [conflict, pending, retryable, synced]) {
        equal(
          repositories.syncQueue.requeueRejectedUpload(seeded.invoiceUuid, {
            idempotencyKey: seeded.invoiceUuid,
            payloadHash: seeded.payloadHash
          }),
          false
        )
      }

      equal(queueRow(database, conflict.queueUuid).state, 'conflict')
      equal(queueRow(database, pending.queueUuid).state, 'pending')
      equal(queueRow(database, retryable.queueUuid).state, 'retryable_error')
      equal(queueRow(database, synced.queueUuid).state, 'synced')
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'a rejected queue row whose invoice row disagrees is refused, not half-written',
  (sandbox) => {
    const database = openTestDatabase(sandbox)

    try {
      const repositories = realRepositories(database)
      const seeded = seedRejectedServiceSale(repositories, { n: '1', state: 'rejected' })

      // The two rows are written together by the outcome recorder, so this state should be
      // unreachable. If it ever happens, the re-offer must refuse rather than leave the queue row
      // pending over an invoice that says something else.
      database
        .prepare("UPDATE local_invoices SET sync_status = 'conflict' WHERE local_uuid = ?")
        .run(seeded.invoiceUuid)

      throws(() =>
        repositories.syncQueue.requeueRejectedUpload(seeded.invoiceUuid, {
          idempotencyKey: seeded.invoiceUuid,
          payloadHash: seeded.payloadHash
        })
      )

      // The transaction rolled back: the queue row is still terminal.
      equal(queueRow(database, seeded.queueUuid).state, 'rejected')
    } finally {
      closeDatabase(database)
    }
  }
)
