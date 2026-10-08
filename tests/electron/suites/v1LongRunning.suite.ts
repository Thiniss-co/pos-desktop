import { createHash } from 'node:crypto'
import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { test } from 'node:test'
import type { DesktopApiRoute } from '@shared/constants/apiRoutes'
import type { RefundR4LineInput } from '@shared/contracts/refund.contract'
import { calculateRefund, calculateRefundLine } from '@shared/pos/refundCalculator'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { databaseMigrations } from '../../../src/main/database/migrations'
import {
  ReceiptPrintingService,
  type ReceiptPrintingDependencies
} from '../../../src/main/receipt/receiptPrinting.service'
import {
  ReceiptPrintJobRepository,
  type NewPrintJob
} from '../../../src/main/repositories/receiptPrintJob.repository'
import { allocationItemLineUuid } from '../../../src/main/services/allocationJournal'
import {
  InvoiceDispositionConvergenceService,
  type DispositionConvergenceSummary
} from '../../../src/main/services/invoiceDispositionConvergence.service'
import {
  InvoiceDispositionDiscoveryService,
  phpJsonEncode
} from '../../../src/main/services/invoiceDispositionDiscovery.service'
import { invoiceRequestHash } from '../../../src/main/services/invoiceRequestHash'
import { payloadHash as canonicalPayloadHash } from '../../../src/main/services/localSale.fingerprint'
import { fetchDispositionStatuses } from '../../../src/main/sync/dispositionStatus.client'
import {
  COMPANY_UUID,
  DEVICE_UUID,
  HASH_64,
  NOW,
  WAREHOUSE_UUID,
  insertRow
} from '../support/allocationScenario'
import { openExistingTestDatabase, runTestMigrations } from '../support/openTestDatabase'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'

/**
 * V1 production readiness — long-running behaviour over REAL SQLite and the REAL services.
 *
 * Only the HTTP transport behind the sync-status read and the clocks are faked. Everything else —
 * candidate selection, per-row pacing, verification, the atomic commit, the print-job journal and
 * its startup sweep, the refund calculator — is the production code.
 */

// ---------------------------------------------------------------------------------------------
// 1. Disposition discovery that outlives an operator decision taken later on the server
// ---------------------------------------------------------------------------------------------

const INVOICE_UUID = '00000000-0000-4000-8000-0000000071a1'
const ATTEMPT_KEY = '00000000-0000-4000-8000-0000000071a2'
const ITEM_UUID = '00000000-0000-4000-8000-0000000071a3'
const QUEUE_UUID = '00000000-0000-4000-8000-0000000071a4'
const AUTHORITY_UUID = '00000000-0000-4000-8000-0000000071a5'
const ALLOCATION_UUID = '00000000-0000-4000-8000-0000000071a6'
const CONSUMPTION_UUID = '00000000-0000-4000-8000-0000000071a7'
const PRODUCT_UUID = '00000000-0000-4000-8000-000000000b01'
const SERVER_INVOICE_UUID = '00000000-0000-4000-8000-0000000071b1'
const SERVER_NUMBER = 'POS/2026/0071'
const DISPOSITION_UUID = '00000000-0000-4000-8000-0000000071d1'
const OWNER = { companyUuid: COMPANY_UUID, deviceUuid: DEVICE_UUID }
const QUARANTINE_REASON = 'allocation_sequence_gap'
const OFFLINE_NUMBER = 'POS-000001-20260906-0071a1'

/** The production per-row interval (`DEFAULT_PER_ROW_INTERVAL_MS`); the suite does not override it. */
const PER_ROW_INTERVAL_MS = 2 * 60 * 1000
const T0 = Date.parse('2026-09-06T08:00:00.000Z')

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function migrated(sandbox: DatabaseSandbox): SqliteDatabase {
  const database = openExistingTestDatabase(sandbox)
  runTestMigrations(database, databaseMigrations)
  return database
}

function frozenPayload(): Record<string, unknown> {
  return {
    idempotency_key: INVOICE_UUID,
    local_invoice_uuid: INVOICE_UUID,
    catalog_revision: HASH_64,
    offline_number: OFFLINE_NUMBER,
    sold_at: NOW,
    sold_while_offline: true,
    customer_uuid: null,
    currency: 'USD',
    tax_mode: 'none',
    client_contract_version: 3,
    shift_uuid: COMPANY_UUID,
    offline_sale_authority_uuid: AUTHORITY_UUID,
    items: [
      {
        product_uuid: PRODUCT_UUID,
        barcode: null,
        quantity: '12.000',
        unit_price_amount: 1000,
        currency: 'USD',
        price_revision: HASH_64,
        tax_id: null,
        tax_mode: 'none',
        tax_rate_basis_points: 0,
        tax_revision: HASH_64,
        discount_type: null,
        discount_value: 0,
        stock_authorization: 'mixed',
        allocations: [
          {
            allocation_uuid: ALLOCATION_UUID,
            rights_generation: 1,
            consumption_sequence: 4,
            local_consumption_uuid: CONSUMPTION_UUID,
            quantity_milli: 5000
          }
        ]
      }
    ],
    invoice_discount: { type: null, value: 0 },
    payments: [
      {
        payment_method_uuid: COMPANY_UUID,
        type: 'cash',
        amount: 12000,
        reference: null,
        paid_at: NOW
      }
    ],
    notes: null
  }
}

/** One rejected, quarantined v3 physical-presence sale: invoice, item, journal row and queue row. */
function seedQuarantinedSale(database: SqliteDatabase): { payloadJson: string } {
  insertRow(database, 'offline_sale_authorities', {
    authority_uuid: AUTHORITY_UUID,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    mode: 'physical_presence',
    policy_revision: 1,
    contract_version: 3,
    issued_at: NOW,
    not_before: NOW,
    not_after: '2099-01-01T00:00:00.000Z',
    authority_hash: HASH_64,
    observed_at: NOW,
    created_at: NOW
  })
  insertRow(database, 'sale_attempts', {
    attempt_key: ATTEMPT_KEY,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    user_uuid: COMPANY_UUID,
    claim_session_epoch: 1,
    origin_shift_uuid: COMPANY_UUID,
    origin_shift_observed_at: NOW,
    origin_branch_uuid: COMPANY_UUID,
    origin_warehouse_uuid: WAREHOUSE_UUID,
    origin_context_fingerprint: HASH_64,
    intent_fingerprint: HASH_64,
    intent_version: 1,
    intent_json: '{"v":1}',
    state: 'claimed',
    claimed_at: NOW,
    updated_at: NOW
  })
  insertRow(database, 'local_invoices', {
    local_uuid: INVOICE_UUID,
    attempt_key: ATTEMPT_KEY,
    offline_number: OFFLINE_NUMBER,
    sync_status: 'rejected',
    sync_attempts: 1,
    company_uuid: COMPANY_UUID,
    branch_uuid: COMPANY_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    device_uuid: DEVICE_UUID,
    user_uuid: COMPANY_UUID,
    shift_uuid: COMPANY_UUID,
    commit_session_epoch: 1,
    catalog_revision: HASH_64,
    intent_fingerprint: HASH_64,
    currency: 'USD',
    currency_exponent: 2,
    tax_mode: 'none',
    invoice_discount_value: 0,
    subtotal_amount: 12000,
    discount_total_amount: 0,
    tax_total_amount: 0,
    grand_total_amount: 12000,
    paid_total_amount: 12000,
    change_due_amount: 0,
    due_amount: 0,
    sold_at: NOW,
    connectivity_state_at_sale: 'offline',
    sold_while_offline: 1,
    commercial_snapshot_json: '{}',
    upload_payload_version: 3,
    offline_sale_authority_uuid: AUTHORITY_UUID,
    stock_authorization_policy: 'physical_presence',
    created_at: NOW,
    updated_at: NOW
  })
  insertRow(database, 'stock_allocation_grants', {
    allocation_uuid: ALLOCATION_UUID,
    contract_version: 1,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    product_uuid: PRODUCT_UUID,
    server_sequence: 1,
    rights_generation: 1,
    lifecycle_generation: 1,
    granted_quantity_milli: 10000,
    server_consumed_quantity_milli: 0,
    consume_until: '2099-01-01T00:00:00.000Z',
    status: 'active',
    envelope_hash: HASH_64,
    received_at: NOW,
    updated_at: NOW
  })
  insertRow(database, 'local_invoice_items', {
    local_uuid: ITEM_UUID,
    invoice_local_uuid: INVOICE_UUID,
    line_index: 0,
    product_uuid: PRODUCT_UUID,
    product_name: 'Widget',
    track_stock: 1,
    quantity_milli: 12000,
    unit_price_amount: 1000,
    currency: 'USD',
    price_revision: HASH_64,
    tax_mode: 'none',
    tax_rate_basis_points: 0,
    tax_revision: HASH_64,
    discount_value: 0,
    subtotal_amount: 12000,
    discount_amount: 0,
    tax_amount: 0,
    total_amount: 12000,
    allocation_covered_milli: 5000,
    uncovered_milli: 7000,
    created_at: NOW
  })
  insertRow(database, 'local_stock_allocation_consumptions', {
    local_uuid: CONSUMPTION_UUID,
    allocation_uuid: ALLOCATION_UUID,
    consumption_sequence: 4,
    invoice_local_uuid: INVOICE_UUID,
    item_local_uuid: ITEM_UUID,
    quantity_milli: 5000,
    server_status: 'pending',
    rights_generation: 1,
    invoice_idempotency_key: INVOICE_UUID,
    item_line_uuid: allocationItemLineUuid(INVOICE_UUID, 0),
    created_at: NOW
  })

  const payload = frozenPayload()
  const payloadJson = JSON.stringify(payload)

  insertRow(database, 'sync_queue', {
    local_queue_uuid: QUEUE_UUID,
    aggregate_type: 'invoice',
    local_aggregate_uuid: INVOICE_UUID,
    operation: 'upload',
    payload_json: payloadJson,
    payload_hash: canonicalPayloadHash(payload),
    idempotency_key: INVOICE_UUID,
    state: 'rejected',
    attempt_count: 1,
    last_error_code: 'DESKTOP_INVOICE_QUARANTINED',
    last_error_details: JSON.stringify({
      backendCode: 'DESKTOP_INVOICE_QUARANTINED',
      httpStatus: 422,
      quarantineReason: QUARANTINE_REASON,
      message: 'quarantined'
    }),
    created_at: NOW,
    updated_at: NOW
  })

  return { payloadJson }
}

type Decision = 'accept_without_proof' | 'reject_permanently'

/** Recursively re-sorts object keys the way a MySQL JSON column returns them. */
function mysqlKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(mysqlKeyOrder)
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.length - right.length || (left < right ? -1 : 1))
        .map(([key, nested]) => [key, mysqlKeyOrder(nested)])
    )
  }

  return value
}

/** What the backend's sync-status read answers for the sale, before and after the decision. */
function serverEntry(payloadJson: string, decision: Decision | null): Record<string, unknown> {
  const base = {
    idempotency_key: INVOICE_UUID,
    local_invoice_uuid: INVOICE_UUID,
    client_contract_version: 3,
    quarantine_reason: QUARANTINE_REASON,
    quarantined_at: NOW
  }

  if (decision === null) {
    return { ...base, status: 'quarantined', processed_at: null, invoice: null, disposition: null }
  }

  const accepting = decision === 'accept_without_proof'
  const requestHash = invoiceRequestHash(JSON.parse(payloadJson))
  const invoice = accepting
    ? { invoice_uuid: SERVER_INVOICE_UUID, server_number: SERVER_NUMBER }
    : null
  const result: Record<string, unknown> = {
    version: 1,
    decision,
    decided_at: '2026-09-06T10:00:00+00:00',
    binding: {
      idempotency_key: INVOICE_UUID,
      local_invoice_uuid: INVOICE_UUID,
      request_hash: requestHash,
      client_contract_version: 3,
      offline_sale_authority_uuid: AUTHORITY_UUID
    },
    invoice,
    proof_results: [
      {
        line_index: 0,
        proof_index: 0,
        allocation_uuid: ALLOCATION_UUID,
        rights_generation: 1,
        consumption_sequence: 4,
        local_consumption_uuid: CONSUMPTION_UUID,
        item_line_uuid: allocationItemLineUuid(INVOICE_UUID, 0),
        quantity_milli: 5000,
        request_hash: requestHash,
        outcome: 'overridden',
        server_consumption_uuid: null,
        override_reason: accepting ? QUARANTINE_REASON : 'permanent_rejection'
      }
    ],
    coverage: [],
    required_holds: [
      {
        allocation_uuid: ALLOCATION_UUID,
        rights_generation: 1,
        first_overridden_sequence: 4,
        reason: 'invoice_disposition_chain_break',
        release_allowed: false
      }
    ]
  }

  return {
    ...base,
    status: accepting ? 'processed' : 'quarantined',
    processed_at: accepting ? '2026-09-06T10:00:00+00:00' : null,
    invoice,
    disposition: {
      id: DISPOSITION_UUID,
      decision,
      decided_at: result.decided_at,
      result_version: 1,
      // Hashed over the backend's insertion order, then served in MySQL's key order.
      result_hash: sha256(phpJsonEncode(result)),
      result: mysqlKeyOrder(result)
    }
  }
}

/** Everything the sale owns locally, in a form that can be compared byte-for-byte. */
function localSnapshot(database: SqliteDatabase): Record<string, unknown> {
  const all = (sql: string): unknown[] => database.prepare(sql).all()

  return {
    invoice: all('SELECT * FROM local_invoices'),
    items: all('SELECT * FROM local_invoice_items'),
    queue: all('SELECT * FROM sync_queue'),
    journal: all('SELECT * FROM local_stock_allocation_consumptions ORDER BY local_uuid'),
    grants: all('SELECT * FROM stock_allocation_grants'),
    applications: all('SELECT * FROM invoice_disposition_applications'),
    proofResults: all('SELECT * FROM invoice_disposition_proof_results'),
    holds: all('SELECT * FROM stock_allocation_disposition_holds'),
    conflicts: all('SELECT * FROM invoice_disposition_conflicts')
  }
}

function count(database: SqliteDatabase, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

interface Harness {
  readonly convergence: InvoiceDispositionConvergenceService
  /** Every sync-status read the device made, as the idempotency keys it put on the wire. */
  readonly asked: string[][]
  readonly converged: DispositionConvergenceSummary[]
  setClock(ms: number): void
  setServerDecision(decision: Decision | null): void
}

/**
 * One long-lived convergence service, as main holds it for the whole session, over the real
 * discovery service and the real sync-status client. Only `apiClient.request` (the HTTP hop) and the
 * clocks are fakes.
 */
function harness(database: SqliteDatabase, payloadJson: string): Harness {
  let nowMs = T0
  let decision: Decision | null = null
  const asked: string[][] = []
  const converged: DispositionConvergenceSummary[] = []

  const apiClient = {
    async request<T>(route: DesktopApiRoute): Promise<T> {
      const [path, query = ''] = route.path.split('?')
      equal(path, '/invoices/sync-status')
      equal(route.method, 'GET')
      ok(!route.path.includes('admin'))
      const keys = new URLSearchParams(query).getAll('idempotency_keys[]')
      asked.push(keys)

      return {
        statuses: keys.map((key) =>
          key === INVOICE_UUID
            ? serverEntry(payloadJson, decision)
            : { idempotency_key: key, status: 'not_found' }
        )
      } as T
    }
  }

  const discovery = new InvoiceDispositionDiscoveryService({
    database,
    now: () => new Date(nowMs)
  })
  const convergence = new InvoiceDispositionConvergenceService({
    discovery,
    fetchStatuses: (keys) => fetchDispositionStatuses(apiClient, keys),
    owner: () => OWNER,
    onConverged: (summary) => converged.push(summary),
    now: () => nowMs
  })

  return {
    convergence,
    asked,
    converged,
    setClock: (ms) => {
      nowMs = ms
    },
    setServerDecision: (next) => {
      decision = next
    }
  }
}

const NOTHING: DispositionConvergenceSummary = {
  asked: 0,
  undecided: 0,
  applied: 0,
  noop: 0,
  conflicts: 0
}

for (const decision of ['accept_without_proof', 'reject_permanently'] as const) {
  databaseTest(
    `V1 long-running discovery converges once on a later operator decision (${decision})`,
    async (sandbox) => {
      const database = migrated(sandbox)
      const { payloadJson } = seedQuarantinedSale(database)
      const h = harness(database, payloadJson)
      const before = localSnapshot(database)

      // Run 1 at t0: the server holds the sale in quarantine with no decision yet.
      h.setClock(T0)
      deepEqual(await h.convergence.run(), { ...NOTHING, asked: 1, undecided: 1 })
      deepEqual(h.asked, [[INVOICE_UUID]], 'the quarantined sale must be asked about')
      deepEqual(localSnapshot(database), before, 'an undecided quarantine changes nothing locally')
      equal(h.converged.length, 0)

      // The operator decides on the server. Run 2 is still inside the per-row pacing window.
      h.setServerDecision(decision)
      h.setClock(T0 + 30_000)
      deepEqual(await h.convergence.run(), NOTHING)
      equal(h.asked.length, 1, 'a row asked about recently must not be asked again yet')
      deepEqual(localSnapshot(database), before)

      // One millisecond short of the window is still inside it.
      h.setClock(T0 + PER_ROW_INTERVAL_MS - 1)
      deepEqual(await h.convergence.run(), NOTHING)
      equal(h.asked.length, 1)
      deepEqual(localSnapshot(database), before)

      // Run 3 after the window: asked once more, and the decision converges exactly once.
      const appliedAt = T0 + PER_ROW_INTERVAL_MS + 1_000
      h.setClock(appliedAt)
      deepEqual(await h.convergence.run(), { ...NOTHING, asked: 1, applied: 1 })
      deepEqual(h.asked, [[INVOICE_UUID], [INVOICE_UUID]])
      deepEqual(h.converged, [{ ...NOTHING, asked: 1, applied: 1 }])

      const after = localSnapshot(database)
      const [invoiceBefore] = before.invoice as Array<Record<string, unknown>>
      const [invoiceAfter] = after.invoice as Array<Record<string, unknown>>
      const [queueBefore] = before.queue as Array<Record<string, unknown>>
      const [queueAfter] = after.queue as Array<Record<string, unknown>>
      const appliedIso = new Date(appliedAt).toISOString()

      // Same sale: same local uuid, same idempotency key, frozen payload and hash untouched.
      equal(invoiceAfter.local_uuid, INVOICE_UUID)
      equal(invoiceAfter.offline_number, OFFLINE_NUMBER)
      equal(queueAfter.local_queue_uuid, QUEUE_UUID)
      equal(queueAfter.idempotency_key, INVOICE_UUID)
      equal(queueAfter.payload_json, queueBefore.payload_json)
      equal(queueAfter.payload_hash, queueBefore.payload_hash)
      equal(queueAfter.attempt_count, queueBefore.attempt_count, 'never re-uploaded')
      deepEqual(after.items, before.items)
      deepEqual(after.journal, before.journal, 'the immutable journal stays byte-identical')
      deepEqual(after.grants, before.grants)
      deepEqual(after.conflicts, [])

      if (decision === 'accept_without_proof') {
        equal(invoiceAfter.sync_status, 'synced')
        equal(invoiceAfter.remote_uuid, SERVER_INVOICE_UUID)
        equal(invoiceAfter.server_number, SERVER_NUMBER)
        equal(invoiceAfter.synced_at, appliedIso)
        equal(queueAfter.state, 'synced')
      } else {
        // A permanent rejection commits nothing: the record stays visibly blocked.
        deepEqual(invoiceAfter, invoiceBefore)
        deepEqual(queueAfter, queueBefore)
      }

      deepEqual(
        database
          .prepare(
            'SELECT invoice_local_uuid, disposition_uuid, decision, remote_invoice_uuid, applied_at FROM invoice_disposition_applications'
          )
          .all(),
        [
          {
            invoice_local_uuid: INVOICE_UUID,
            disposition_uuid: DISPOSITION_UUID,
            decision,
            remote_invoice_uuid: decision === 'accept_without_proof' ? SERVER_INVOICE_UUID : null,
            applied_at: appliedIso
          }
        ]
      )
      equal(count(database, 'invoice_disposition_proof_results'), 1)
      deepEqual(
        database
          .prepare(
            'SELECT allocation_uuid, rights_generation, invoice_local_uuid, first_overridden_sequence, release_allowed FROM stock_allocation_disposition_holds'
          )
          .all(),
        [
          {
            allocation_uuid: ALLOCATION_UUID,
            rights_generation: 1,
            invoice_local_uuid: INVOICE_UUID,
            first_overridden_sequence: 4,
            release_allowed: 0
          }
        ]
      )

      // Run 4, well past any window: the application finalizes the row, so it is not asked again.
      h.setClock(T0 + 10 * PER_ROW_INTERVAL_MS)
      deepEqual(await h.convergence.run(), NOTHING)
      equal(h.asked.length, 2, 'a converged row is never asked about again')
      equal(h.converged.length, 1)
      deepEqual(localSnapshot(database), after)

      // A fresh service (a restarted process) over the same database does not re-ask either.
      const restarted = harness(database, payloadJson)
      restarted.setServerDecision(decision)
      restarted.setClock(T0 + 20 * PER_ROW_INTERVAL_MS)
      deepEqual(await restarted.convergence.run(), NOTHING)
      deepEqual(restarted.asked, [])
      deepEqual(localSnapshot(database), after)

      closeDatabase(database)
    }
  )
}

// ---------------------------------------------------------------------------------------------
// 2. Automatic and manual print jobs recovered at startup by a fresh process
// ---------------------------------------------------------------------------------------------

const USER_UUID = '00000000-0000-4000-8000-0000000072c1'
const PRINT_CREATED_AT = '2026-09-06T09:00:00.000Z'
const PRINT_RESTART_AT = '2026-09-06T09:30:00.000Z'
const PRINT_SECOND_RESTART_AT = '2026-09-06T10:00:00.000Z'

/** Columns no transition — the startup sweep included — may ever rewrite. */
const IMMUTABLE_PRINT_COLUMNS = [
  'job_uuid',
  'request_id',
  'client_intent_json',
  'client_intent_sha256',
  'trigger',
  'owner_company_uuid',
  'owner_device_uuid',
  'requested_by_user_uuid',
  'session_epoch_at_claim',
  'document_kind',
  'document_local_uuid',
  'document_json',
  'document_sha256',
  'template_version',
  'locale',
  'is_reprint',
  'facts_projection',
  'transaction_facts_sha256',
  'resolved_options_json',
  'options_sha256',
  'layout_json',
  'layout_sha256',
  'qr_verified_sha256',
  'worker_lease_id',
  'dispatch_token',
  'cancel_origin',
  'created_at',
  'preparing_at',
  'dispatched_at'
] as const

function jobUuid(index: number): string {
  return `00000000-0000-4000-8000-0000000072${index.toString(16).padStart(2, '0')}`
}

function saleUuid(index: number): string {
  return `00000000-0000-4000-8000-0000000073${index.toString(16).padStart(2, '0')}`
}

function newJob(index: number, trigger: 'manual' | 'auto'): NewPrintJob {
  return {
    jobUuid: jobUuid(index),
    requestId: trigger === 'auto' ? `auto-sale:${saleUuid(index)}` : jobUuid(index),
    clientIntentJson: '{}',
    clientIntentSha256: HASH_64,
    trigger,
    ownerCompanyUuid: COMPANY_UUID,
    ownerDeviceUuid: DEVICE_UUID,
    requestedByUserUuid: USER_UUID,
    sessionEpochAtClaim: 1,
    documentKind: 'sale',
    documentLocalUuid: saleUuid(index),
    documentJson: '{}',
    documentSha256: HASH_64,
    templateVersion: 2,
    locale: 'en',
    isReprint: false,
    factsProjection: 'sale-facts/1',
    transactionFactsSha256: HASH_64,
    resolvedOptionsJson: '{}',
    optionsSha256: HASH_64,
    createdAt: PRINT_CREATED_AT
  }
}

type SeededStage =
  'queued' | 'preparing' | 'dispatching' | 'submitted-released' | 'cancelled' | 'unknown-timeout'

/** Drives one job through the REAL repository transitions a worker performs, up to `stage`. */
function seedJob(
  jobs: ReceiptPrintJobRepository,
  index: number,
  trigger: 'manual' | 'auto',
  stage: SeededStage
): void {
  const uuid = jobUuid(index)
  const lease = `lease-${index}`
  const token = `token-${index}`
  ok(jobs.claim(newJob(index, trigger)), `claim ${uuid}`)

  if (stage === 'queued') return
  if (stage === 'cancelled') {
    equal(jobs.markCancelledFromQueue(uuid, PRINT_CREATED_AT), 1)
    return
  }

  equal(jobs.beginPreparing(uuid, lease, PRINT_CREATED_AT), 1)
  if (stage === 'preparing') return

  equal(jobs.recordLayout(uuid, lease, '{"lines":[]}', HASH_64), 1)
  equal(jobs.recordQrVerified(uuid, lease, HASH_64), 1)
  equal(jobs.beginDispatching(uuid, lease, token, PRINT_CREATED_AT), 1)
  if (stage === 'dispatching') return

  if (stage === 'submitted-released') {
    equal(jobs.markSubmitted(uuid, token, PRINT_CREATED_AT), 1)
    equal(jobs.recordWindowReleased(uuid, lease, PRINT_CREATED_AT), 1)
    return
  }

  equal(jobs.markOutcomeUnknownFromTimeout(uuid, token, PRINT_CREATED_AT), 1)
}

function readJobs(database: SqliteDatabase): Map<string, Record<string, unknown>> {
  const rows = database
    .prepare('SELECT * FROM receipt_print_jobs ORDER BY job_uuid')
    .all() as Array<Record<string, unknown>>
  return new Map(rows.map((row) => [row.job_uuid as string, row]))
}

function immutable(row: Record<string, unknown> | undefined): Record<string, unknown> {
  ok(row)
  return Object.fromEntries(IMMUTABLE_PRINT_COLUMNS.map((column) => [column, row[column]]))
}

/** Exactly what `createApplicationServices` does at startup, on a brand-new connection. */
function restartAndReconcile(sandbox: DatabaseSandbox, at: string): SqliteDatabase {
  const database = openExistingTestDatabase(sandbox)
  const printing = new ReceiptPrintingService({
    jobs: new ReceiptPrintJobRepository(database),
    now: () => new Date(at)
  } as unknown as ReceiptPrintingDependencies)
  printing.reconcileStartup()
  return database
}

databaseTest(
  'V1 startup recovery settles interrupted automatic and manual print jobs exactly once',
  (sandbox) => {
    // The previous process: jobs left mid-flight by a crash or power loss.
    const previous = migrated(sandbox)
    const seedJobs = new ReceiptPrintJobRepository(previous)
    seedJob(seedJobs, 1, 'manual', 'queued')
    seedJob(seedJobs, 2, 'auto', 'queued')
    seedJob(seedJobs, 3, 'manual', 'preparing')
    seedJob(seedJobs, 4, 'auto', 'preparing')
    seedJob(seedJobs, 5, 'manual', 'dispatching')
    seedJob(seedJobs, 6, 'auto', 'dispatching')
    seedJob(seedJobs, 7, 'manual', 'submitted-released')
    seedJob(seedJobs, 8, 'auto', 'submitted-released')
    seedJob(seedJobs, 9, 'manual', 'cancelled')
    seedJob(seedJobs, 10, 'manual', 'unknown-timeout')
    const seeded = readJobs(previous)
    closeDatabase(previous)

    // Process 2 starts.
    const database = restartAndReconcile(sandbox, PRINT_RESTART_AT)
    const recovered = readJobs(database)
    equal(recovered.size, seeded.size, 'no job is ever deleted or duplicated')

    for (const [uuid, row] of recovered) {
      deepEqual(immutable(row), immutable(seeded.get(uuid)), `immutable columns of ${uuid}`)
    }

    // Never dispatched: queued/preparing become failed_before_dispatch.
    for (const index of [1, 2, 3, 4]) {
      const row = recovered.get(jobUuid(index))!
      equal(row.status, 'failed_before_dispatch', `job ${index}`)
      equal(row.failure_code, 'INTERRUPTED_BEFORE_DISPATCH')
      equal(row.finished_at, PRINT_RESTART_AT)
      equal(row.dispatch_token, null)
      equal(row.dispatched_at, null)
      equal(row.unknown_at, null)
      // Only a job a worker had leased has a window to release.
      equal(row.window_released_at, index >= 3 ? PRINT_RESTART_AT : null)
    }

    // Possibly printed: dispatching becomes outcome_unknown, never re-queued or re-dispatched.
    for (const index of [5, 6]) {
      const row = recovered.get(jobUuid(index))!
      equal(row.status, 'outcome_unknown', `job ${index}`)
      equal(row.failure_code, 'INTERRUPTED_AFTER_DISPATCH')
      equal(row.unknown_at, PRINT_RESTART_AT)
      equal(row.finished_at, null)
      equal(row.os_callback_at, null)
      equal(row.window_released_at, PRINT_RESTART_AT)
    }

    // Already terminal and released: byte-identical.
    for (const index of [7, 8, 9]) {
      deepEqual(recovered.get(jobUuid(index)), seeded.get(jobUuid(index)), `job ${index}`)
    }

    // A terminal job whose window was never released: only that marker is written.
    const timedOut = recovered.get(jobUuid(10))!
    deepEqual(
      { ...timedOut, window_released_at: null },
      seeded.get(jobUuid(10)),
      'only window_released_at may change on an already-terminal job'
    )
    equal(timedOut.window_released_at, PRINT_RESTART_AT)

    const jobs = new ReceiptPrintJobRepository(database)

    for (const index of [1, 2, 3, 4, 5, 6]) {
      const uuid = jobUuid(index)
      // No stale worker of the previous process can resume any of them.
      equal(jobs.beginPreparing(uuid, `lease-${index}`, PRINT_RESTART_AT), 0)
      equal(jobs.beginDispatching(uuid, `lease-${index}`, `again-${index}`, PRINT_RESTART_AT), 0)
      // And the database itself refuses a regression to a pre-dispatch state.
      throws(() =>
        database.prepare("UPDATE receipt_print_jobs SET status='queued' WHERE job_uuid=?").run(uuid)
      )
      throws(() =>
        database
          .prepare("UPDATE receipt_print_jobs SET status='dispatching' WHERE job_uuid=?")
          .run(uuid)
      )
    }

    // An automatic print is admitted at most once per sale, ever: no second AUTO job can be
    // claimed for a sale whose automatic print may already have reached the printer.
    for (const index of [2, 4, 6, 8]) {
      equal(
        jobs.claim({
          ...newJob(index, 'auto'),
          jobUuid: jobUuid(0x80 + index),
          requestId: `retry-${index}`
        }),
        null,
        `a second auto job for sale ${index} must be refused`
      )
    }

    const afterFirst = readJobs(database)
    closeDatabase(database)

    // Process 3 starts: the sweep is idempotent.
    const again = restartAndReconcile(sandbox, PRINT_SECOND_RESTART_AT)
    deepEqual(readJobs(again), afterFirst, 'a second startup sweep changes nothing')

    // A late OS success for an interrupted-after-dispatch job is still recorded (T14), with its
    // original token; the job is not dispatched again to get there.
    const finalJobs = new ReceiptPrintJobRepository(again)
    equal(finalJobs.markSubmitted(jobUuid(5), 'token-5', PRINT_SECOND_RESTART_AT), 1)
    const lateSuccess = finalJobs.findByJobUuid(jobUuid(5))!
    equal(lateSuccess.status, 'submitted')
    equal(lateSuccess.dispatchToken, 'token-5')
    equal(lateSuccess.dispatchedAt, PRINT_CREATED_AT)
    // The interruption evidence is kept on the row rather than erased by the late success.
    equal(lateSuccess.failureCode, 'INTERRUPTED_AFTER_DISPATCH')

    closeDatabase(again)
  }
)

// ---------------------------------------------------------------------------------------------
// 3. Over-refund refusal in the pure R4 calculator (`src/shared/pos/refundCalculator.ts`)
// ---------------------------------------------------------------------------------------------

function refundLine(overrides: Partial<RefundR4LineInput> = {}): RefundR4LineInput {
  return {
    invoiceItemRemoteUuid: '00000000-0000-4000-8000-0000000074a1',
    productUuid: PRODUCT_UUID,
    productName: 'Loose rice',
    taxMode: 'exclusive',
    // 2.500 kg sold for 2500 + 375 tax.
    originalQuantityMilli: 2500,
    originalSubtotalAmount: 2500,
    originalDiscountAmount: 0,
    originalTaxAmount: 375,
    originalTotalAmount: 2875,
    priorRefundedQuantityMilli: 0,
    priorSubtotalAmount: 0,
    priorDiscountAmount: 0,
    priorTaxAmount: 0,
    priorTotalAmount: 0,
    requestedQuantityMilli: 1000,
    feasibility: { tier: 'ok', reasons: [] },
    ...overrides
  }
}

const OVER_REFUND = /cannot exceed the original invoice item quantity/

test('V1 refund calculator refuses an over-refund and accepts an exact fractional remainder', () => {
  // More than was ever sold, in one go.
  throws(() => calculateRefundLine(refundLine({ requestedQuantityMilli: 2501 })), OVER_REFUND)

  // More than remains after a prior partial refund of 1.250 kg (1438 refunded of 2875).
  const afterPrior = {
    priorRefundedQuantityMilli: 1250,
    priorSubtotalAmount: 1250,
    priorTaxAmount: 188,
    priorTotalAmount: 1438
  }
  throws(
    () => calculateRefundLine(refundLine({ ...afterPrior, requestedQuantityMilli: 1251 })),
    OVER_REFUND
  )
  // One over-refunding line refuses the whole refund, not just that line.
  throws(
    () =>
      calculateRefund([
        refundLine({ requestedQuantityMilli: 500 }),
        refundLine({ ...afterPrior, invoiceItemRemoteUuid: 'other', requestedQuantityMilli: 1251 })
      ]),
    OVER_REFUND
  )
  // Zero and negative are refused by the same guard.
  throws(() => calculateRefundLine(refundLine({ requestedQuantityMilli: 0 })), OVER_REFUND)
  throws(() => calculateRefundLine(refundLine({ requestedQuantityMilli: -1 })), OVER_REFUND)

  // Exactly the fractional remainder (1.250 kg) is accepted and returns exactly what is left,
  // so the two refunds together reverse precisely what was charged.
  const remainder = calculateRefundLine(refundLine({ ...afterPrior, requestedQuantityMilli: 1250 }))
  equal(remainder.totalAmount, 2875 - 1438)
  equal(remainder.taxAmount, 375 - 188)
  equal(remainder.subtotalAmount, 2500 - 1250)

  // The whole fractional quantity at once is accepted too.
  deepEqual(calculateRefund([refundLine({ requestedQuantityMilli: 2500 })]), {
    lines: [
      {
        invoiceItemRemoteUuid: '00000000-0000-4000-8000-0000000074a1',
        subtotalAmount: 2500,
        discountAmount: 0,
        taxAmount: 375,
        totalAmount: 2875
      }
    ],
    subtotalAmount: 2500,
    discountTotalAmount: 0,
    taxTotalAmount: 375,
    grandTotalAmount: 2875
  })
})
