import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

/**
 * The live-backend fixture handed to this process by `scripts/cp3g5LiveUpload.mjs`.
 *
 * CP-3G-5 proves the upload against a **real Laravel** endpoint, so the suite needs real credentials
 * and real minted payloads. They are produced outside this process, against a disposable database,
 * and passed in by path. When they are absent the suite skips rather than inventing a server —
 * `npm run test:sqlite:electron` must stay runnable with no backend.
 */
export interface LiveUploadFixture {
  readonly origin: string
  readonly token: string
  readonly deviceUuid: string
  readonly companyUuid: string
  readonly shiftUuid: string
  /** Ready-to-send v2 upload bodies, each with its own invoice uuid and consumption sequence. */
  readonly payloads: readonly Record<string, unknown>[]
}

let cached: LiveUploadFixture | null | undefined

export function liveUploadFixture(): LiveUploadFixture | null {
  if (cached !== undefined) {
    return cached
  }

  const path = process.env.CP3G5_FIXTURE
  const origin = process.env.CP3G5_API_ORIGIN

  if (!path || !origin) {
    cached = null

    return cached
  }

  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    token: string
    device_uuid: string
    company_uuid: string
    shift_uuid: string
    payloads: Record<string, unknown>[]
  }

  cached = {
    origin,
    token: raw.token,
    deviceUuid: raw.device_uuid,
    companyUuid: raw.company_uuid,
    shiftUuid: raw.shift_uuid,
    payloads: raw.payloads
  }

  return cached
}

/** The business tables CP-3G-5 counts on the server side. */
export const BACKEND_BUSINESS_TABLES = [
  'pos_invoices',
  'pos_invoice_items',
  'pos_payments',
  'desktop_invoice_syncs',
  'stock_movements',
  'stock_allocation_consumptions',
  'shift_post_close_adjustments'
] as const

export interface BackendInvoiceRow {
  readonly uuid: string
  readonly server_number: string
  /** Attribution derived server-side from the immutable shift, never from the uploader. */
  readonly cashier_user_id: number
  readonly shift_id: number
  readonly branch_id: number
  readonly warehouse_id: number
}

/** The BE-3F-3 uploader audit row written beside every accepted upload. */
export interface BackendUploadAuditRow {
  readonly local_invoice_uuid: string
  readonly idempotency_key: string
  readonly status: string
  readonly origin_shift_id: number
  readonly uploader_user_id: number
  readonly client_contract_version: number
  readonly legacy_path_used: number
}

/** The immutable shift the backend derives historical attribution from. */
export interface BackendShiftRow {
  readonly id: number
  readonly uuid: string
  readonly user_id: number
  readonly branch_id: number
  readonly warehouse_id: number
  readonly status: string
}

export interface BackendSnapshot {
  readonly counts: Readonly<Record<string, number>>
  readonly invoiceUuids: readonly string[]
  readonly serverNumbers: readonly string[]
  readonly invoices: readonly BackendInvoiceRow[]
  readonly uploadAudits: readonly BackendUploadAuditRow[]
  readonly shifts: readonly BackendShiftRow[]
  readonly stockQuantity: string | null
  readonly allocationConsumedMilli: number | null
}

/**
 * Reads the live Laravel database directly.
 *
 * The backend runs on a **disposable SQLite file**, so the same better-sqlite3 ABI this app ships
 * can read it in-process and count real server rows mid-test. Opened read-only: the desktop side
 * must observe the server, never write to it.
 */
export function readBackendSnapshot(): BackendSnapshot {
  const databasePath = process.env.CP3G5_BACKEND_DB

  if (!databasePath) {
    throw new Error('CP3G5_BACKEND_DB is required to read the live backend state')
  }

  const database = new Database(databasePath, { readonly: true })

  try {
    const counts: Record<string, number> = {}

    for (const table of BACKEND_BUSINESS_TABLES) {
      counts[table] = (
        database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }
      ).total
    }

    const invoices = database
      .prepare(
        'SELECT uuid, server_number, cashier_user_id, shift_id, branch_id, warehouse_id FROM pos_invoices ORDER BY id'
      )
      .all() as BackendInvoiceRow[]

    const uploadAudits = database
      .prepare(
        'SELECT local_invoice_uuid, idempotency_key, status, origin_shift_id, uploader_user_id, client_contract_version, legacy_path_used FROM desktop_invoice_syncs ORDER BY id'
      )
      .all() as BackendUploadAuditRow[]

    const shifts = database
      .prepare('SELECT id, uuid, user_id, branch_id, warehouse_id, status FROM shifts ORDER BY id')
      .all() as BackendShiftRow[]

    const stock = database.prepare('SELECT quantity FROM stock_items LIMIT 1').get() as
      { quantity: string } | undefined
    const allocation = database
      .prepare('SELECT consumed_quantity_milli FROM stock_allocations LIMIT 1')
      .get() as { consumed_quantity_milli: number } | undefined

    return {
      counts,
      invoiceUuids: invoices.map((row) => row.uuid),
      serverNumbers: invoices.map((row) => row.server_number),
      invoices,
      uploadAudits,
      shifts,
      stockQuantity: stock?.quantity ?? null,
      allocationConsumedMilli: allocation?.consumed_quantity_milli ?? null
    }
  } finally {
    database.close()
  }
}

/** True when this process was handed a live CP-3G-5 backend to run against. */
export function liveUploadBackendAvailable(): boolean {
  return liveUploadFixture() !== null && Boolean(process.env.CP3G5_BACKEND_DB)
}

/** The per-scenario server-side effects of one uploaded invoice. */
export interface BackendScenarioEffects {
  /** Server invoices carrying this payload's offline number — must never exceed one. */
  readonly invoicesForOfflineNumber: number
  readonly itemsForOfflineNumber: number
  readonly paymentsForOfflineNumber: number
  /** Uploader audit rows (BE-3F-3) recorded for this local invoice uuid. */
  readonly uploadAuditsForInvoice: number
  readonly movementsForOfflineNumber: number
  readonly consumptionsForAllocation: number
  readonly postCloseAdjustmentsForOfflineNumber: number
  readonly allocationConsumedMilli: number | null
  readonly stockQuantity: string | null
  readonly stockAvailableQuantity: string | null
  readonly invoiceUuid: string | null
  readonly serverNumber: string | null
}

/**
 * Counts the effects of exactly one scenario, keyed by that payload's own offline number and its
 * own allocation grant.
 *
 * CP-3G-5 mints one product, stock item and allocation per payload, so a per-scenario read is the
 * only honest way to say "this invoice consumed stock once" when many scenarios share one disposable
 * server. Read-only, exactly like `readBackendSnapshot`.
 */
export function readScenarioEffects(
  offlineNumber: string,
  allocationUuid: string,
  localInvoiceUuid: string
): BackendScenarioEffects {
  const databasePath = process.env.CP3G5_BACKEND_DB

  if (!databasePath) {
    throw new Error('CP3G5_BACKEND_DB is required to read the live backend state')
  }

  const database = new Database(databasePath, { readonly: true })

  try {
    const scalar = (sql: string, ...parameters: readonly unknown[]): number =>
      (database.prepare(sql).get(...parameters) as { total: number }).total

    const invoice = database
      .prepare('SELECT id, uuid, server_number FROM pos_invoices WHERE offline_number = ?')
      .get(offlineNumber) as { id: number; uuid: string; server_number: string } | undefined

    const allocation = database
      .prepare(
        'SELECT id, stock_item_id, consumed_quantity_milli FROM stock_allocations WHERE uuid = ?'
      )
      .get(allocationUuid) as
      { id: number; stock_item_id: number; consumed_quantity_milli: number } | undefined

    const stock = allocation
      ? (database
          .prepare('SELECT quantity, available_quantity FROM stock_items WHERE id = ?')
          .get(allocation.stock_item_id) as
          { quantity: string; available_quantity: string } | undefined)
      : undefined

    return {
      invoicesForOfflineNumber: scalar(
        'SELECT COUNT(*) AS total FROM pos_invoices WHERE offline_number = ?',
        offlineNumber
      ),
      itemsForOfflineNumber: invoice
        ? scalar(
            'SELECT COUNT(*) AS total FROM pos_invoice_items WHERE pos_invoice_id = ?',
            invoice.id
          )
        : 0,
      paymentsForOfflineNumber: invoice
        ? scalar('SELECT COUNT(*) AS total FROM pos_payments WHERE pos_invoice_id = ?', invoice.id)
        : 0,
      uploadAuditsForInvoice: scalar(
        'SELECT COUNT(*) AS total FROM desktop_invoice_syncs WHERE local_invoice_uuid = ?',
        localInvoiceUuid
      ),
      movementsForOfflineNumber: invoice
        ? scalar(
            'SELECT COUNT(*) AS total FROM stock_movements WHERE pos_invoice_id = ?',
            invoice.id
          )
        : 0,
      consumptionsForAllocation: allocation
        ? scalar(
            'SELECT COUNT(*) AS total FROM stock_allocation_consumptions WHERE stock_allocation_id = ?',
            allocation.id
          )
        : 0,
      postCloseAdjustmentsForOfflineNumber: invoice
        ? scalar(
            'SELECT COUNT(*) AS total FROM shift_post_close_adjustments WHERE pos_invoice_id = ?',
            invoice.id
          )
        : 0,
      allocationConsumedMilli: allocation?.consumed_quantity_milli ?? null,
      stockQuantity: stock?.quantity ?? null,
      stockAvailableQuantity: stock?.available_quantity ?? null,
      invoiceUuid: invoice?.uuid ?? null,
      serverNumber: invoice?.server_number ?? null
    }
  } finally {
    database.close()
  }
}
