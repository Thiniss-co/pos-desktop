import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import { CompanyAccessStateService } from '../../../src/main/services/companyAccessState.service'
import { payloadHash } from '../../../src/main/services/localSale.fingerprint'
import { RefundService } from '../../../src/main/services/refund.service'
import { uploadInvoice } from '../../../src/main/sync/invoiceUpload.client'
import { COMPANY_SUSPENDED_RETRY_MS } from '../../../src/main/sync/invoiceUploadMapping'
import { InvoiceUploadOutcomeRecorder } from '../../../src/main/sync/invoiceUploadOutcome'
import { InvoiceUploadWorker } from '../../../src/main/sync/invoiceUploadWorker'
import { uploadRefund } from '../../../src/main/sync/refundUpload.client'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'

/**
 * Phase 3 — a held upload stays on the till and goes through after the company is resumed.
 *
 * Real Electron SQLite (production migrations and repositories), the real `InvoiceUploadWorker`,
 * `uploadInvoice`, `RefundService`, `uploadRefund`, `DesktopApiClient` and `CompanyAccessStateService`.
 * Only the network is scripted: it answers exactly what the Phase 3 backend answers — a retryable
 * `403 COMPANY_SUSPENDED` (with `meta.company_access`) for a held legacy v1 upload or a first refund
 * acceptance while suspended, and the normal 201 (carrying the lifted state) once resumed.
 */

const HASH_64 = 'a'.repeat(64)
const COMPANY = '11111111-1111-4111-8111-111111111111'
const DEVICE = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const SHIFT = '55555555-5555-4555-8555-555555555555'
const T0 = Date.parse('2026-10-06T12:00:00.000Z')

function uuid(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
}

const suspendedAccess = {
  company_id: COMPANY,
  state: 'suspended',
  revision: 1,
  suspended_at: '2026-10-06T11:00:00+00:00'
}
const activeAccess = { company_id: COMPANY, state: 'active', revision: 2, suspended_at: null }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function suspendedResponse(): Response {
  return json(403, {
    success: false,
    message: 'This company is suspended.',
    code: 'COMPANY_SUSPENDED',
    errors: [],
    meta: { trace_id: 'trace-held', company_access: suspendedAccess }
  })
}

function invoiceAccepted(localUuid: string, access: unknown): Response {
  return json(201, {
    success: true,
    message: 'Uploaded.',
    code: 'DESKTOP_INVOICE_UPLOADED',
    data: {
      id: uuid(`9${localUuid.slice(-4)}`),
      server_number: `INV-${localUuid.slice(-4)}`,
      offline_number: null,
      status: 'completed',
      payment_status: 'paid',
      currency: 'USD',
      subtotal_amount: 1000,
      discount_total_amount: 0,
      tax_total_amount: 0,
      grand_total_amount: 1000,
      paid_total_amount: 1000,
      change_due_amount: 0,
      due_amount: 0,
      sold_at: '2026-10-06T09:00:00Z'
    },
    meta: { trace_id: 'trace-ok', company_access: access }
  })
}

interface Network {
  suspended: boolean
  readonly requests: string[]
  readonly fetchImplementation: typeof fetch
}

/** Answers like the Phase 3 backend: the held kinds are refused while suspended; the rest is accepted. */
function network(heldInvoices: ReadonlySet<string>): Network {
  const state: Network = {
    suspended: true,
    requests: [],
    fetchImplementation: async (input, init) => {
      const url = new URL(String(input))
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>

      if (url.pathname.endsWith('/invoices/upload')) {
        const local = String(body.local_invoice_uuid)
        state.requests.push(`invoice:${local}`)

        if (state.suspended && heldInvoices.has(local)) {
          return suspendedResponse()
        }

        return invoiceAccepted(local, state.suspended ? suspendedAccess : activeAccess)
      }

      if (url.pathname.endsWith('/refunds/upload')) {
        state.requests.push(`refund:${String(body.idempotency_key)}`)

        if (state.suspended) {
          return suspendedResponse()
        }

        return json(201, {
          success: true,
          message: 'Refund uploaded.',
          code: 'DESKTOP_REFUND_UPLOADED',
          data: {
            id: uuid('77'),
            refund_number: 'RF-0001',
            offline_refund_number: null,
            status: 'completed',
            payment_status: 'refunded',
            subtotal_amount: 1000,
            discount_total_amount: 0,
            tax_total_amount: 0,
            grand_total_amount: 1000,
            refunded_total_amount: 1000,
            refunded_at: '2026-10-06T10:30:00Z'
          },
          meta: { trace_id: 'trace-refund', company_access: activeAccess }
        })
      }

      return json(404, { success: false, message: 'Not found', code: 'NOT_FOUND', errors: [] })
    }
  }

  return state
}

interface Harness {
  readonly database: SqliteDatabase
  readonly repositories: RealRepositories
  readonly net: Network
  readonly apiClient: DesktopApiClient
  readonly access: CompanyAccessStateService
  readonly clock: { now: number }
}

function harness(database: SqliteDatabase, repositories: RealRepositories, net: Network): Harness {
  const clock = { now: T0 }
  const settings = new Map<string, string>()
  const access = new CompanyAccessStateService(
    { get: (key) => settings.get(key) ?? null, set: (key, value) => void settings.set(key, value) },
    { getContext: () => ({ isAuthenticated: true, companyUuid: COMPANY }) },
    () => new Date(clock.now)
  )
  const apiClient = new DesktopApiClient({
    apiOrigin: new URL('http://backend.test'),
    getAccessToken: () => 'token',
    getDeviceUuid: () => DEVICE,
    fetchImplementation: net.fetchImplementation,
    onCompanyAccessObserved: (observed) => access.observe(observed)
  })

  return { database, repositories, net, apiClient, access, clock }
}

function worker(h: Harness): InvoiceUploadWorker {
  return new InvoiceUploadWorker({
    syncQueue: h.repositories.syncQueue,
    recorder: new InvoiceUploadOutcomeRecorder({
      database: h.database,
      syncQueue: h.repositories.syncQueue,
      localSale: h.repositories.localSale,
      syncConflicts: h.repositories.syncConflicts,
      now: () => new Date(h.clock.now).toISOString()
    }),
    // `sync` stays allowed while suspended (CommercialAccessService only denies `sell`).
    commercialAccess: { assertAllowed: () => undefined },
    permissions: { hasPermission: () => true },
    session: {
      getContext: () => ({ isAuthenticated: true, companyUuid: COMPANY, deviceUuid: DEVICE })
    },
    upload: (payloadJson) => uploadInvoice(h.apiClient, payloadJson),
    now: () => new Date(h.clock.now),
    schedule: () => () => undefined
  })
}

/** A committed sale and its immutable queue row. `legacy` freezes a pre-Phase-3F (v1) payload. */
function seedQueuedSale(
  h: Harness,
  n: string,
  legacy: boolean
): { invoiceUuid: string; queueUuid: string; payloadJson: string } {
  const invoiceUuid = uuid(`1${n}`)
  const queueUuid = uuid(`2${n}`)
  const attemptKey = uuid(`3${n}`)
  const createdAt = '2026-10-06T09:00:00.000Z'
  const payload: Record<string, unknown> = {
    local_invoice_uuid: invoiceUuid,
    offline_number: `POS-${n}`,
    sold_at: '2026-10-06T09:00:00Z',
    catalog_revision: HASH_64,
    items: [{ product_uuid: uuid('6'), quantity: '1.000' }],
    ...(legacy ? {} : { client_contract_version: 2, shift_uuid: SHIFT })
  }
  const payloadJson = JSON.stringify(payload)

  h.repositories.saleAttempts.claim({
    attemptKey,
    companyUuid: COMPANY,
    deviceUuid: DEVICE,
    userUuid: USER,
    claimSessionEpoch: 1,
    originShiftUuid: SHIFT,
    originShiftObservedAt: createdAt,
    originBranchUuid: uuid('8'),
    originWarehouseUuid: uuid('7'),
    originContextFingerprint: HASH_64,
    intentFingerprint: HASH_64,
    intentVersion: 1,
    intentJson: '{"v":1}'
  })
  h.repositories.localSale.insertInvoice({
    localUuid: invoiceUuid,
    attemptKey,
    offlineNumber: `POS-${n}`,
    companyUuid: COMPANY,
    branchUuid: uuid('8'),
    warehouseUuid: uuid('7'),
    deviceUuid: DEVICE,
    userUuid: USER,
    shiftUuid: SHIFT,
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
    soldAt: createdAt,
    connectivityStateAtSale: 'offline',
    soldWhileOffline: true,
    notes: null,
    commercialSnapshotJson: '{}',
    createdAt
  })
  h.repositories.saleAttempts.markCommitted(attemptKey, invoiceUuid, createdAt)
  h.repositories.syncQueue.enqueue({
    localQueueUuid: queueUuid,
    aggregateType: 'invoice',
    localAggregateUuid: invoiceUuid,
    operation: 'upload',
    payloadJson,
    payloadHash: payloadHash(payload),
    idempotencyKey: invoiceUuid
  })
  h.database
    .prepare('UPDATE sync_queue SET created_at = ?, updated_at = ? WHERE local_queue_uuid = ?')
    .run(createdAt, createdAt, queueUuid)

  return { invoiceUuid, queueUuid, payloadJson }
}

interface QueueRow {
  readonly state: string
  readonly attempt_count: number
  readonly last_error_code: string | null
  readonly next_attempt_at: string | null
  readonly payload_json: string
}

function queueRow(database: SqliteDatabase, queueUuid: string): QueueRow {
  return database
    .prepare(
      'SELECT state, attempt_count, last_error_code, next_attempt_at, payload_json FROM sync_queue WHERE local_queue_uuid = ?'
    )
    .get(queueUuid) as QueueRow
}

function invoiceSync(database: SqliteDatabase, invoiceUuid: string): string {
  return (
    database
      .prepare('SELECT sync_status FROM local_invoices WHERE local_uuid = ?')
      .get(invoiceUuid) as {
      sync_status: string
    }
  ).sync_status
}

databaseTest(
  'a held legacy upload stays queued with its exact bytes, never pauses the queue, and syncs after resumption',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)

    try {
      const repositories = realRepositories(database)
      const legacyUuid = uuid('11')
      const net = network(new Set([legacyUuid]))
      const h = harness(database, repositories, net)
      const legacy = seedQueuedSale(h, '1', true)
      const current = seedQueuedSale(h, '2', false)
      equal(legacy.invoiceUuid, legacyUuid)

      // 1. Suspended: the legacy sale is held, the other one still uploads (per item, no pause).
      const first = await worker(h).run()
      equal(first.pausedReason, null)
      deepEqual(net.requests, [`invoice:${legacy.invoiceUuid}`, `invoice:${current.invoiceUuid}`])
      equal(h.access.isSuspended(), true)

      const held = queueRow(database, legacy.queueUuid)
      equal(held.state, 'retryable_error')
      equal(held.last_error_code, 'COMPANY_SUSPENDED')
      equal(held.attempt_count, 1)
      equal(held.payload_json, legacy.payloadJson)
      ok(Date.parse(held.next_attempt_at ?? '') >= T0 + COMPANY_SUSPENDED_RETRY_MS)
      equal(invoiceSync(database, legacy.invoiceUuid), 'retryable_error')
      equal(queueRow(database, current.queueUuid).state, 'synced')
      equal(repositories.syncQueue.getStatus(null).counts.rejected, 0)

      // 2. Still suspended, before the backoff: nothing is re-sent.
      h.clock.now = T0 + 60_000
      await worker(h).run()
      equal(net.requests.length, 2)

      // 3. A fresh worker over the same database (as after a restart), past the backoff: re-sent, held again.
      h.clock.now = T0 + COMPANY_SUSPENDED_RETRY_MS + 1_000
      await worker(h).run()
      equal(net.requests.length, 3)
      equal(queueRow(database, legacy.queueUuid).state, 'retryable_error')
      equal(queueRow(database, legacy.queueUuid).attempt_count, 2)

      // 4. Resumed: the next due attempt sends the identical frozen bytes once and syncs; the
      //    response's `meta.company_access` lifts the suspension on the till.
      net.suspended = false
      h.clock.now = T0 + 3 * COMPANY_SUSPENDED_RETRY_MS
      const after = await worker(h).run()
      equal(after.uploaded, 1)
      equal(net.requests.length, 4)
      equal(net.requests[3], `invoice:${legacy.invoiceUuid}`)
      equal(queueRow(database, legacy.queueUuid).state, 'synced')
      equal(queueRow(database, legacy.queueUuid).payload_json, legacy.payloadJson)
      equal(invoiceSync(database, legacy.invoiceUuid), 'synced')
      equal(h.access.isSuspended(), false)
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'a held refund stays resumable on the till (never rejected) and is accepted after resumption',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)

    try {
      const repositories = realRepositories(database)
      const net = network(new Set())
      const h = harness(database, repositories, net)
      const sale = seedQueuedSale(h, '3', false)
      database
        .prepare(
          "UPDATE local_invoices SET sync_status = 'synced', remote_uuid = ?, server_number = 'INV-1', synced_at = ? WHERE local_uuid = ?"
        )
        .run(uuid('88'), '2026-10-06T09:05:00.000Z', sale.invoiceUuid)

      const refundUuid = uuid('41')
      const requestJson = JSON.stringify({ idempotency_key: refundUuid, amount: 1000 })
      const now = '2026-10-06T10:30:00.000Z'
      repositories.localRefunds.insert(
        {
          localUuid: refundUuid,
          invoiceLocalUuid: sale.invoiceUuid,
          invoiceRemoteUuid: uuid('88'),
          companyUuid: COMPANY,
          deviceUuid: DEVICE,
          userUuid: USER,
          shiftUuid: SHIFT,
          currency: 'USD',
          currencyExponent: 2,
          subtotalAmount: 1000,
          discountTotalAmount: 0,
          taxTotalAmount: 0,
          grandTotalAmount: 1000,
          refundedAt: now,
          stockReturned: true,
          reason: null,
          notes: null,
          requestJson,
          requestSha256: HASH_64,
          previewId: uuid('42'),
          createdAt: now
        },
        [
          {
            localUuid: uuid('43'),
            refundLocalUuid: refundUuid,
            lineIndex: 0,
            invoiceItemRemoteUuid: uuid('44'),
            productUuid: uuid('6'),
            productName: 'Product',
            quantityMilli: 1000,
            priorRefundedQuantityMilli: 0,
            subtotalAmount: 1000,
            discountAmount: 0,
            taxAmount: 0,
            totalAmount: 1000,
            taxMode: 'exclusive',
            createdAt: now
          }
        ],
        [
          {
            localUuid: uuid('45'),
            refundLocalUuid: refundUuid,
            paymentIndex: 0,
            paymentMethodUuid: null,
            type: 'cash',
            amount: 1000,
            reference: null,
            createdAt: now
          }
        ]
      )
      // The refund was sent before the suspension and its answer was lost: `unresolved`.
      repositories.localRefunds.claimForDispatch(refundUuid, now)
      repositories.localRefunds.markUnresolved(refundUuid, 'transport', 'timeout', now)

      // Resuming an existing refund needs none of the new-refund dependencies.
      const refunds = new RefundService({
        apiClient: h.apiClient,
        localSale: repositories.localSale,
        localRefunds: repositories.localRefunds,
        access: undefined as never,
        shiftAuthority: undefined as never,
        catalog: { listPaymentMethods: () => [] },
        now: () => new Date(h.clock.now),
        uploadRefund
      })

      // Suspended: the server holds the first acceptance; the till keeps it resumable.
      const held = await refunds.resumeRefund(refundUuid)
      equal(net.requests.length, 1)
      const heldRow = repositories.localRefunds.findByLocalUuid(refundUuid)
      equal(heldRow?.submissionState, 'unresolved')
      equal(heldRow?.lastErrorCode, 'COMPANY_SUSPENDED')
      equal(heldRow?.requestJson, requestJson)
      ok(held.localRefundUuid === refundUuid)
      equal(h.access.isSuspended(), true)

      // Resumed: the same frozen bytes are accepted.
      net.suspended = false
      await refunds.resumeRefund(refundUuid)
      const accepted = repositories.localRefunds.findByLocalUuid(refundUuid)
      equal(accepted?.submissionState, 'accepted')
      equal(accepted?.refundNumber, 'RF-0001')
      equal(accepted?.requestJson, requestJson)
      equal(net.requests.length, 2)
      equal(h.access.isSuspended(), false)
    } finally {
      closeDatabase(database)
    }
  }
)
