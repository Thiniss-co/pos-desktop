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
  /**
   * PS7: one v3 physical-presence body — recorded stock 20, sale 22, and NO allocation at all.
   *
   * Optional so a fixture minted by an older seeder still parses: an absent key means the live
   * physical-presence scenario simply does not run, rather than the whole suite failing.
   */
  readonly physicalPresencePayloads: readonly Record<string, unknown>[]
  readonly physicalPresenceProductUuid: string | null
  /**
   * PS8: the catalog/authority context the desktop needs to BUILD a v3 payload with its own
   * generator — including an untracked service product, which is the shape the old FormRequest
   * refused. Absent from a fixture minted by an older seeder, in which case that suite skips.
   */
  readonly serviceLineContext: ServiceLineContext | null
}

/** One product as the sale-time catalog issued it. */
export interface ServiceLineCatalogEntry {
  readonly product_uuid: string
  readonly unit_price_amount: number
  readonly price_revision: string
  readonly tax_id: string | null
  readonly tax_mode: string
  readonly tax_rate_basis_points: number
  readonly tax_revision: string
}

export interface ServiceLineContext {
  readonly sold_at: string
  readonly catalog_revision: string
  readonly authority_uuid: string
  readonly payment_method_uuid: string
  readonly currency: string
  readonly service: ServiceLineCatalogEntry
  readonly tracked: ServiceLineCatalogEntry
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
    physical_presence_payloads?: Record<string, unknown>[]
    physical_presence_product_uuid?: string
    service_line_context?: ServiceLineContext
  }

  cached = {
    origin,
    token: raw.token,
    deviceUuid: raw.device_uuid,
    companyUuid: raw.company_uuid,
    shiftUuid: raw.shift_uuid,
    payloads: raw.payloads,
    physicalPresencePayloads: raw.physical_presence_payloads ?? [],
    physicalPresenceProductUuid: raw.physical_presence_product_uuid ?? null,
    serviceLineContext: raw.service_line_context ?? null
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
/**
 * Whether a live backend carrying the CP-3G-5 **v2** payload set was provided.
 *
 * The payload requirement is deliberate. PS7's live runner mints a fixture with only a
 * physical-presence payload, and the CP-3G-5 suites genuinely cannot run against it — without this
 * they would FAIL rather than skip, reporting a fixture mismatch as a product defect.
 */
export function liveUploadBackendAvailable(): boolean {
  const fixture = liveUploadFixture()

  return fixture !== null && fixture.payloads.length > 0 && Boolean(process.env.CP3G5_BACKEND_DB)
}

/** Whether a live backend carrying the PS8 service-line catalog context was provided. */
export function liveServiceLineBackendAvailable(): boolean {
  const fixture = liveUploadFixture()

  return (
    fixture !== null && fixture.serviceLineContext !== null && Boolean(process.env.CP3G5_BACKEND_DB)
  )
}

/** Whether a live backend carrying the PS7 physical-presence payload was provided. */
export function livePhysicalPresenceBackendAvailable(): boolean {
  const fixture = liveUploadFixture()

  return (
    fixture !== null &&
    fixture.physicalPresencePayloads.length > 0 &&
    fixture.physicalPresenceProductUuid !== null &&
    Boolean(process.env.CP3G5_BACKEND_DB)
  )
}

/**
 * A single numeric aggregate read from the live backend database, read-only.
 *
 * This lives here rather than in each live suite because `tests/electron/support` is the sanctioned
 * home for native database entry points — `electronHarnessIntegrity.test.ts` sweeps every file
 * under `tests/electron` for `new Database(` and allows it only in a support module. A suite that
 * opened the server's database itself would both duplicate this and break that gate.
 */
export function liveBackendScalar(sql: string, ...parameters: readonly unknown[]): number {
  const databasePath = process.env.CP3G5_BACKEND_DB

  if (!databasePath) {
    throw new Error('CP3G5_BACKEND_DB is required to read the live backend state')
  }

  const database = new Database(databasePath, { readonly: true })

  try {
    return (database.prepare(sql).get(...parameters) as { total: number }).total
  } finally {
    database.close()
  }
}

/**
 * One product's live stock row, in integer thousandths.
 *
 * SQLite gives a `decimal(14,3)` column NUMERIC affinity, so the stored `'20.000'` comes back from
 * the driver as the number `20` and the exact decimal text is not recoverable from this side.
 * Rounding to thousandths is exact at these magnitudes and keeps the assertion an integer
 * comparison rather than a float one. The BACKEND never does this — it reads through Eloquent's
 * `decimal:3` cast and folds through `App\Shared\Support\Quantity`; this is a constraint of
 * reading its test database from outside.
 */
export function liveBackendStock(productUuid: string): {
  readonly quantityMilli: number
  readonly availableQuantityMilli: number
  readonly inventoryValueAmount: number
} | null {
  const databasePath = process.env.CP3G5_BACKEND_DB

  if (!databasePath) {
    throw new Error('CP3G5_BACKEND_DB is required to read the live backend state')
  }

  const database = new Database(databasePath, { readonly: true })

  try {
    const row = database
      .prepare(
        `SELECT s.quantity, s.available_quantity, s.inventory_value_amount
           FROM stock_items s
           JOIN products p ON p.id = s.product_id
          WHERE p.uuid = ?`
      )
      .get(productUuid) as
      { quantity: string; available_quantity: string; inventory_value_amount: number } | undefined

    return row
      ? {
          quantityMilli: Math.round(Number(row.quantity) * 1000),
          availableQuantityMilli: Math.round(Number(row.available_quantity) * 1000),
          inventoryValueAmount: row.inventory_value_amount
        }
      : null
  } finally {
    database.close()
  }
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
