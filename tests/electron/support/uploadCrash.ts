import { appendFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { SqliteDatabase } from '../../../src/main/database/connection'
import { payloadHash } from '../../../src/main/services/localSale.fingerprint'
import type { InvoiceUploadAccepted } from '../../../src/main/sync/invoiceUpload.client'
import { InvoiceUploadOutcomeRecorder } from '../../../src/main/sync/invoiceUploadOutcome'
import {
  InvoiceUploadWorker,
  type InvoiceUploadWorkerSessionReader
} from '../../../src/main/sync/invoiceUploadWorker'
import type { RealRepositories } from './realRepositories'

/**
 * Shared CP-3G-6 crash-recovery support.
 *
 * Both halves of every crash proof use this module — the suite that seeds a queued invoice and
 * verifies the aftermath, and the separate Electron process that claims the row and is then hard
 * killed. Keeping the seed shape and the worker construction in one place is what lets the two
 * processes agree about identity without either one telling the other what to look for.
 */

/** The kill boundaries CP-3G-6 covers. Each names a real point in one dispatch. */
export type CrashStage =
  /** Claim committed (`pending -> uploading`, lease written); nothing dispatched yet. */
  | 'before-dispatch'
  /** The request has been handed to the transport; no answer has been observed. */
  | 'in-flight'
  /** The server's response bytes have arrived at the transport; nothing parsed or persisted. */
  | 'response-received'
  /** The answer is parsed and accepted; the outcome transaction has not started. */
  | 'before-outcome'
  /** Inside the outcome transaction, after the queue row was written and before it commits. */
  | 'during-outcome'

export const CRASH_MARKER_FILENAME = 'cp3g6-marker.json'

export function crashMarkerPath(markerDirectory: string): string {
  return join(markerDirectory, CRASH_MARKER_FILENAME)
}

/**
 * Publishes the coordination file the parent waits on, atomically.
 *
 * Written through a temporary name and renamed, so the parent can never read a half-written file
 * and mistake it for a boundary that was reached. It carries states, counts, hashes and business
 * identities only: no token, no header value, no payment reference.
 */
export function publishCrashMarker(markerDirectory: string, marker: Record<string, unknown>): void {
  const target = crashMarkerPath(markerDirectory)
  const staging = `${target}.staging`

  writeFileSync(staging, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600 })
  renameSync(staging, target)
}

/** A stable fingerprint of exactly the bytes that went on the wire. */
export function bodyDigest(bodyText: string): string {
  return createHash('sha256').update(bodyText).digest('hex')
}

/** The identity fields a retry must reproduce exactly. Business identifiers only. */
export interface UploadIdentity {
  readonly idempotencyKey: string
  readonly localInvoiceUuid: string
  readonly shiftUuid: string
  readonly catalogRevision: string
  readonly offlineNumber: string
  readonly allocationUuid: string
  readonly rightsGeneration: number
  readonly consumptionSequence: number
  readonly localConsumptionUuid: string
}

export function uploadIdentity(body: Record<string, unknown>): UploadIdentity {
  const items = body.items as readonly Record<string, unknown>[]
  const allocation = (items[0]!.allocations as readonly Record<string, unknown>[])[0]!

  return {
    idempotencyKey: String(body.idempotency_key),
    localInvoiceUuid: String(body.local_invoice_uuid),
    shiftUuid: String(body.shift_uuid),
    catalogRevision: String(body.catalog_revision),
    offlineNumber: String(body.offline_number),
    allocationUuid: String(allocation.allocation_uuid),
    rightsGeneration: Number(allocation.rights_generation),
    consumptionSequence: Number(allocation.consumption_sequence),
    localConsumptionUuid: String(allocation.local_consumption_uuid)
  }
}

/**
 * Blocks the process at a boundary until something outside it decides its fate.
 *
 * The ceiling exists so a wiring mistake fails as a failed test rather than as a hung suite; a
 * worker that reaches it exits non-zero and never pretends to have been killed.
 */
export const PARK_CEILING_MS = 120_000

export async function parkUntilKilled(): Promise<never> {
  await new Promise((resolve) => {
    setTimeout(resolve, PARK_CEILING_MS)
  })

  throw new Error('crash boundary was never terminated')
}

/** The synchronous form, for a boundary inside an open SQLite transaction. */
export function parkUntilKilledSync(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PARK_CEILING_MS)
  throw new Error('crash boundary was never terminated')
}

export interface UploadWorkerOptions {
  readonly database: SqliteDatabase
  readonly repositories: RealRepositories
  readonly owner: { readonly companyUuid: string; readonly deviceUuid: string }
  readonly upload: (payloadJson: string) => Promise<InvoiceUploadAccepted>
  /**
   * Shifts the worker's clock. The lease policy, its duration and every transition stay exactly as
   * production defines them; only the reading of "now" moves, through the worker's own injection
   * point. Nothing here weakens production timing.
   */
  readonly nowOffsetMs?: number
  readonly hasPermission?: boolean
  /**
   * Replaces the session reader, for the cases that must have **no** authoritative owner. The
   * production worker resolves the reclaim owner from this reader alone; nothing else can supply
   * it.
   */
  readonly session?: InvoiceUploadWorkerSessionReader
}

/** The production worker over production repositories, with only the clock and transport injected. */
export function buildUploadWorker(options: UploadWorkerOptions): InvoiceUploadWorker {
  const offset = options.nowOffsetMs ?? 0

  return new InvoiceUploadWorker({
    syncQueue: options.repositories.syncQueue,
    recorder: new InvoiceUploadOutcomeRecorder({
      database: options.database,
      syncQueue: options.repositories.syncQueue,
      localSale: options.repositories.localSale,
      syncConflicts: options.repositories.syncConflicts,
      now: () => new Date(Date.now() + offset).toISOString()
    }),
    commercialAccess: { assertAllowed: (): void => undefined },
    permissions: { hasPermission: () => options.hasPermission !== false },
    session: options.session ?? {
      getContext: () => ({
        isAuthenticated: true,
        companyUuid: options.owner.companyUuid,
        deviceUuid: options.owner.deviceUuid
      })
    },
    upload: options.upload,
    now: () => new Date(Date.now() + offset),
    // No real timers: a crash-recovery proof schedules its own restarts explicitly.
    schedule: () => () => undefined
  })
}

const HASH_64 = 'a'.repeat(64)
const USER = '44444444-4444-4444-8444-444444444444'

export interface SeededInvoice {
  readonly invoiceUuid: string
  readonly queueUuid: string
  readonly payload: Record<string, unknown>
  readonly payloadJson: string
  readonly payloadHash: string
}

export interface SeedOptions {
  readonly n: string
  readonly payload: Record<string, unknown>
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly shiftUuid: string
  readonly breakPayloadHash?: boolean
  readonly createdAt?: string
  /** Overrides the cashier who committed the sale, for the cross-user recovery cases. */
  readonly userUuid?: string
  /** Overrides the epoch the sale was committed under, for the session-rotation cases. */
  readonly commitSessionEpoch?: number
}

/**
 * A committed sale and its one immutable invoice-upload queue row, exactly as Phase 3F leaves them
 * on disk before any upload has been attempted.
 */
export function seedQueuedInvoice(
  database: SqliteDatabase,
  repositories: RealRepositories,
  options: SeedOptions
): SeededInvoice {
  const invoiceUuid = String(options.payload.local_invoice_uuid)
  const queueUuid = testUuid(`2${options.n}`)
  const attemptKey = testUuid(`3${options.n}`)
  const createdAt = options.createdAt ?? '2026-09-03T10:00:00.000Z'
  const payloadJson = JSON.stringify(options.payload)
  const hash = payloadHash(options.payload)
  const userUuid = options.userUuid ?? USER
  const commitSessionEpoch = options.commitSessionEpoch ?? 1

  repositories.saleAttempts.claim({
    attemptKey,
    companyUuid: options.companyUuid,
    deviceUuid: options.deviceUuid,
    userUuid,
    claimSessionEpoch: commitSessionEpoch,
    originShiftUuid: options.shiftUuid,
    originShiftObservedAt: createdAt,
    originBranchUuid: testUuid('8'),
    originWarehouseUuid: testUuid('7'),
    originContextFingerprint: HASH_64,
    intentFingerprint: HASH_64,
    intentVersion: 1,
    intentJson: '{"v":1}'
  })

  repositories.localSale.insertInvoice({
    localUuid: invoiceUuid,
    attemptKey,
    offlineNumber: String(options.payload.offline_number ?? `CP3G6-${options.n}`),
    companyUuid: options.companyUuid,
    branchUuid: testUuid('8'),
    warehouseUuid: testUuid('7'),
    deviceUuid: options.deviceUuid,
    userUuid,
    shiftUuid: options.shiftUuid,
    commitSessionEpoch,
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
    payloadHash: options.breakPayloadHash === true ? HASH_64 : hash,
    idempotencyKey: invoiceUuid
  })

  database
    .prepare('UPDATE sync_queue SET created_at = ?, updated_at = ? WHERE local_queue_uuid = ?')
    .run(createdAt, createdAt, queueUuid)

  return { invoiceUuid, queueUuid, payload: options.payload, payloadJson, payloadHash: hash }
}

export function testUuid(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
}

export interface QueueRowSnapshot {
  readonly state: string
  readonly attempt_count: number
  readonly upload_lease_at: string | null
  readonly last_error_code: string | null
  readonly next_attempt_at: string | null
  readonly payload_json: string
  readonly payload_hash: string
  readonly idempotency_key: string
  readonly updated_at: string
}

export function readQueueRow(database: SqliteDatabase, queueUuid: string): QueueRowSnapshot {
  return database
    .prepare(
      `SELECT state, attempt_count, upload_lease_at, last_error_code, next_attempt_at,
              payload_json, payload_hash, idempotency_key, updated_at
       FROM sync_queue WHERE local_queue_uuid = ?`
    )
    .get(queueUuid) as QueueRowSnapshot
}

export interface InvoiceRowSnapshot {
  readonly sync_status: string
  readonly remote_uuid: string | null
  readonly server_number: string | null
  readonly synced_at: string | null
  readonly sync_attempts: number
  readonly grand_total_amount: number
}

export function readInvoiceRow(
  database: SqliteDatabase,
  invoiceUuid: string
): InvoiceRowSnapshot | undefined {
  return database
    .prepare(
      `SELECT sync_status, remote_uuid, server_number, synced_at, sync_attempts, grand_total_amount
       FROM local_invoices WHERE local_uuid = ?`
    )
    .get(invoiceUuid) as InvoiceRowSnapshot | undefined
}

const LOCAL_TABLES = [
  'local_invoices',
  'local_invoice_items',
  'local_invoice_payments',
  'sync_queue',
  'sync_conflicts',
  'local_stock_movements',
  'local_stock_allocation_consumptions'
] as const

export function readLocalCounts(database: SqliteDatabase): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const table of LOCAL_TABLES) {
    counts[table] = (
      database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }
    ).total
  }

  return counts
}

/**
 * Appends one redaction-safe evidence line for the checkpoint report.
 *
 * The live gate captures the Electron suite's output rather than printing it, so the report's
 * numbers come from here. Only counts, states, timestamps, hashes and booleans are written — never
 * a token, a header value or a payment reference.
 */
export function recordEvidence(entry: Record<string, unknown>): void {
  const path = process.env.CP3G6_EVIDENCE

  if (!path) {
    return
  }

  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
}
