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
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'

/**
 * Phase 3 — a held upload stays on the till and goes through after the company is resumed.
 *
 * Real Electron SQLite (production migrations and repositories, on a file that is closed and reopened to
 * model an app restart), the real `InvoiceUploadWorker`, `uploadInvoice`, `RefundService`, `uploadRefund`,
 * `DesktopApiClient`, and `CompanyAccessStateService` over the real `AppSettingsRepository`. Only the network
 * is scripted, as a small model of the Phase 3 backend: an exact replay of a committed upload answers first
 * (200 already uploaded); otherwise a held legacy v1 upload or a first refund acceptance while suspended gets
 * a retryable `403 COMPANY_SUSPENDED` with `meta.company_access`; once resumed it commits once (201, carrying
 * the lifted state). One refund answer can be lost after the commit, like a dropped connection.
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
  /** Commit the next refund, then drop the connection before the answer arrives. */
  loseNextRefundAnswer: boolean
  readonly requests: string[]
  /** The exact request bodies, in order, keyed by route. */
  readonly bodies: { readonly route: 'invoice' | 'refund'; readonly body: string }[]
  readonly committedInvoices: Set<string>
  readonly committedRefunds: Set<string>
  readonly fetchImplementation: typeof fetch
}

function refundAnswer(status: 200 | 201, access: unknown): Response {
  return json(status, {
    success: true,
    message: 'Refund uploaded.',
    code: status === 201 ? 'DESKTOP_REFUND_UPLOADED' : 'DESKTOP_REFUND_ALREADY_UPLOADED',
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
    meta: { trace_id: 'trace-refund', company_access: access }
  })
}

/** A model of the Phase 3 backend for these two routes (see the suite comment). */
function network(heldInvoices: ReadonlySet<string>): Network {
  const state: Network = {
    suspended: true,
    loseNextRefundAnswer: false,
    requests: [],
    bodies: [],
    committedInvoices: new Set(),
    committedRefunds: new Set(),
    fetchImplementation: async (input, init) => {
      const url = new URL(String(input))
      const raw = String(init?.body ?? '{}')
      const body = JSON.parse(raw) as Record<string, unknown>
      const access = state.suspended ? suspendedAccess : activeAccess

      if (url.pathname.endsWith('/invoices/upload')) {
        const local = String(body.local_invoice_uuid)
        state.requests.push(`invoice:${local}`)
        state.bodies.push({ route: 'invoice', body: raw })

        if (state.suspended && heldInvoices.has(local) && !state.committedInvoices.has(local)) {
          return suspendedResponse()
        }

        state.committedInvoices.add(local)
        return invoiceAccepted(local, access)
      }

      if (url.pathname.endsWith('/refunds/upload')) {
        const key = String(body.idempotency_key)
        state.requests.push(`refund:${key}`)
        state.bodies.push({ route: 'refund', body: raw })

        if (state.committedRefunds.has(key)) {
          return refundAnswer(200, access)
        }

        if (state.suspended) {
          return suspendedResponse()
        }

        state.committedRefunds.add(key)

        if (state.loseNextRefundAnswer) {
          state.loseNextRefundAnswer = false
          throw new TypeError('fetch failed')
        }

        return refundAnswer(201, access)
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

/** One app process over the sandbox's SQLite file: everything is rebuilt from what the file holds. */
function boot(sandbox: DatabaseSandbox, net: Network, clock: { now: number }): Harness {
  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const access = new CompanyAccessStateService(
    repositories.appSettings,
    { getContext: () => ({ isAuthenticated: true, companyUuid: COMPANY }) },
    () => new Date(clock.now)
  )
  const apiClient = new DesktopApiClient({
    apiOrigin: new URL('http://backend.test'),
    getAccessToken: () => 'token',
    getDeviceUuid: () => DEVICE,
    fetchImplementation: net.fetchImplementation,
    timeoutMs: 5_000,
    onCompanyAccessObserved: (observed) => access.observe(observed)
  })

  return { database, repositories, net, apiClient, access, clock }
}

/** Closes the process's database and boots a new one on the same file (an app restart). */
function restart(sandbox: DatabaseSandbox, h: Harness): Harness {
  closeDatabase(h.database)
  return boot(sandbox, h.net, h.clock)
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

function refundService(h: Harness): RefundService {
  // Resuming an existing refund needs none of the new-refund dependencies.
  return new RefundService({
    apiClient: h.apiClient,
    localSale: h.repositories.localSale,
    localRefunds: h.repositories.localRefunds,
    access: undefined as never,
    shiftAuthority: undefined as never,
    catalog: { listPaymentMethods: () => [] },
    now: () => new Date(h.clock.now),
    uploadRefund
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
  'a held legacy upload keeps its exact bytes across restarts, never pauses the queue, and syncs once after resumption',
  async (sandbox) => {
    const legacyUuid = uuid('11')
    const net = network(new Set([legacyUuid]))
    let h = boot(sandbox, net, { now: T0 })

    try {
      const legacy = seedQueuedSale(h, '1', true)
      const current = seedQueuedSale(h, '2', false)
      equal(legacy.invoiceUuid, legacyUuid)

      // 1. Suspended: the legacy sale is held, the other one still uploads (per item, no pause).
      const first = await worker(h).run()
      equal(first.pausedReason, null)
      deepEqual(net.requests, [`invoice:${legacy.invoiceUuid}`, `invoice:${current.invoiceUuid}`])
      equal(h.access.isSuspended(), true)

      const held = queueRow(h.database, legacy.queueUuid)
      equal(held.state, 'retryable_error')
      equal(held.last_error_code, 'COMPANY_SUSPENDED')
      equal(held.attempt_count, 1)
      equal(held.payload_json, legacy.payloadJson)
      ok(Date.parse(held.next_attempt_at ?? '') >= T0 + COMPANY_SUSPENDED_RETRY_MS)
      equal(invoiceSync(h.database, legacy.invoiceUuid), 'retryable_error')
      equal(queueRow(h.database, current.queueUuid).state, 'synced')
      equal(h.repositories.syncQueue.getStatus(null).counts.rejected, 0)

      // 2. Restart before the back-off, with no network answer: the suspension and the row are read back.
      h = restart(sandbox, h)
      equal(h.access.isSuspended(), true)
      h.clock.now = T0 + 60_000
      await worker(h).run()
      equal(net.requests.length, 2)
      equal(queueRow(h.database, legacy.queueUuid).payload_json, legacy.payloadJson)

      // 3. Past the back-off, still suspended: re-sent with the same bytes, held again.
      h.clock.now = T0 + COMPANY_SUSPENDED_RETRY_MS + 1_000
      await worker(h).run()
      equal(net.requests.length, 3)
      equal(queueRow(h.database, legacy.queueUuid).state, 'retryable_error')
      equal(queueRow(h.database, legacy.queueUuid).attempt_count, 2)

      // 4. Resumed, after another restart: the next due attempt sends the identical frozen bytes once and
      //    syncs; the answer's newer `active` state lifts the suspension on the till.
      net.suspended = false
      h = restart(sandbox, h)
      equal(h.access.isSuspended(), true)
      h.clock.now = T0 + 3 * COMPANY_SUSPENDED_RETRY_MS
      const after = await worker(h).run()
      equal(after.uploaded, 1)
      equal(net.requests.length, 4)
      const sent = net.bodies.filter(
        (b) => b.route === 'invoice' && b.body.includes(legacy.invoiceUuid)
      )
      equal(sent.length, 3)
      ok(sent.every((b) => b.body === legacy.payloadJson))
      equal(queueRow(h.database, legacy.queueUuid).state, 'synced')
      equal(invoiceSync(h.database, legacy.invoiceUuid), 'synced')
      equal(h.access.isSuspended(), false)

      // 5. Nothing left to send; another run sends nothing.
      await worker(h).run()
      equal(net.requests.length, 4)
    } finally {
      closeDatabase(h.database)
    }
  }
)

databaseTest(
  'a held refund stays resumable across restarts and, after resumption, is accepted once with the same key and bytes even when an answer is lost',
  async (sandbox) => {
    const net = network(new Set())
    let h = boot(sandbox, net, { now: T0 })

    try {
      const sale = seedQueuedSale(h, '3', false)
      h.database
        .prepare(
          "UPDATE local_invoices SET sync_status = 'synced', remote_uuid = ?, server_number = 'INV-1', synced_at = ? WHERE local_uuid = ?"
        )
        .run(uuid('88'), '2026-10-06T09:05:00.000Z', sale.invoiceUuid)

      const refundUuid = uuid('41')
      const requestJson = JSON.stringify({ idempotency_key: refundUuid, amount: 1000 })
      const at = '2026-10-06T10:30:00.000Z'
      h.repositories.localRefunds.insert(
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
          refundedAt: at,
          stockReturned: true,
          reason: null,
          notes: null,
          requestJson,
          requestSha256: HASH_64,
          previewId: uuid('42'),
          createdAt: at
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
            createdAt: at
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
            createdAt: at
          }
        ]
      )
      // Sent before the suspension, its answer lost: `unresolved`.
      h.repositories.localRefunds.claimForDispatch(refundUuid, at)
      h.repositories.localRefunds.markUnresolved(refundUuid, 'transport', 'timeout', at)

      // 1. Suspended: the server holds the first acceptance; the till keeps it resumable, twice.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await refundService(h).resumeRefund(refundUuid)
        const row = h.repositories.localRefunds.findByLocalUuid(refundUuid)
        equal(row?.submissionState, 'unresolved')
        equal(row?.lastErrorCode, 'COMPANY_SUSPENDED')
        equal(row?.requestJson, requestJson)
      }
      equal(h.access.isSuspended(), true)
      equal(net.committedRefunds.size, 0)

      // 2. Restart while suspended: the refund and the known suspension are read back from the file.
      h = restart(sandbox, h)
      equal(h.repositories.localRefunds.findByLocalUuid(refundUuid)?.submissionState, 'unresolved')
      equal(h.access.isSuspended(), true)

      // 3. Resumed: the server commits, but the answer is lost. Still `unresolved`, never `rejected`.
      net.suspended = false
      net.loseNextRefundAnswer = true
      await refundService(h).resumeRefund(refundUuid)
      equal(h.repositories.localRefunds.findByLocalUuid(refundUuid)?.submissionState, 'unresolved')
      equal(net.committedRefunds.size, 1)

      // 4. Restart, resume again: the same key and bytes resolve to the committed refund (duplicate answer).
      h = restart(sandbox, h)
      await refundService(h).resumeRefund(refundUuid)
      const accepted = h.repositories.localRefunds.findByLocalUuid(refundUuid)
      equal(accepted?.submissionState, 'accepted')
      equal(accepted?.refundNumber, 'RF-0001')
      equal(accepted?.requestJson, requestJson)
      equal(h.access.isSuspended(), false)

      const sent = net.bodies.filter((b) => b.route === 'refund')
      equal(sent.length, 4)
      ok(sent.every((b) => b.body === requestJson))
      equal(net.committedRefunds.size, 1)
    } finally {
      closeDatabase(h.database)
    }
  }
)
