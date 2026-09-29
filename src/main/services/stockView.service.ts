import type {
  CatalogBarcodeLookup,
  CatalogProduct,
  CatalogProductForSale,
  CatalogProductPage,
  CatalogSearchInput,
  ProductStockView
} from '@shared/contracts/catalog.contract'
import type { SqliteDatabase } from '../database/connection'
import type { BootstrapSnapshotRepository } from '../repositories/bootstrapSnapshot.repository'
import type { OfflineSaleAuthorityRepository } from '../repositories/offlineSaleAuthority.repository'
import type { StockAllocationRepository } from '../repositories/stockAllocation.repository'
import type { CatalogService } from './catalog.service'
import type { CatalogTrustedClock } from './catalogTrustedClock.service'
import { milliToQuantity } from './localSale.fingerprint'

export interface StockViewOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
}

export interface StockViewDependencies {
  readonly database: SqliteDatabase
  readonly catalog: Pick<
    CatalogService,
    'searchProducts' | 'getProduct' | 'findProductByBarcode' | 'getStatus'
  >
  readonly bootstrapSnapshot: Pick<BootstrapSnapshotRepository, 'getWarehouse'>
  readonly stockAllocations: Pick<
    StockAllocationRepository,
    'usableGrantsForProduct' | 'spendableMilli'
  >
  readonly offlineSaleAuthorities: Pick<OfflineSaleAuthorityRepository, 'findUsable'>
  readonly clock: CatalogTrustedClock
  /** The session's company + device, or null before a session exists. */
  readonly owner: () => StockViewOwner | null
}

/** Signed decimal (3 dp) → integer thousandths; `null` for anything unparseable. */
function decimalToMilli(value: string): number | null {
  const match = /^(-?)(\d{1,9})(?:\.(\d{1,3}))?$/.exec(value.trim())
  if (!match) {
    return null
  }
  const whole = Number(match[2])
  const fraction = Number((match[3] ?? '').padEnd(3, '0'))
  const milli = whole * 1000 + fraction
  return match[1] === '-' ? -milli : milli
}

function signedMilliToQuantity(milli: number): string {
  return milli < 0 ? `-${milliToQuantity(-milli)}` : milliToQuantity(milli)
}

/**
 * POS reliability rev 3 (Area 1) — read-only, separated stock information for the POS, computed in
 * main from SQLite only (no network, no new tables, no adjusted balance).
 *
 * Every POS catalog read that carries stock runs inside ONE SQLite read transaction together with
 * the contract it is labelled with, so rows, revision and stock never come from different installs.
 */
export class StockViewService {
  constructor(private readonly dependencies: StockViewDependencies) {}

  searchPage(input: CatalogSearchInput): CatalogProductPage {
    return this.read(() => {
      const page = this.dependencies.catalog.searchProducts(input)
      return {
        ...page,
        stock: this.viewsFor(page.items, page.contract.revision, page.contract.generatedAt)
      }
    })
  }

  productForSale(uuid: string): CatalogProductForSale {
    return this.read(() => {
      const product = this.dependencies.catalog.getProduct(uuid)
      const contract = this.requireContract()
      return {
        product,
        revision: contract.revision,
        stock: this.viewsFor([product], contract.revision, contract.generatedAt)[product.uuid]
      }
    })
  }

  barcodeForSale(barcode: string): CatalogBarcodeLookup {
    return this.read(() => {
      const lookup = this.dependencies.catalog.findProductByBarcode(barcode)
      if (lookup.outcome !== 'found') {
        return lookup
      }
      return { ...lookup, revision: this.requireContract().revision }
    })
  }

  private read<T>(operation: () => T): T {
    // A deferred read transaction: every statement below sees one consistent database state.
    return this.dependencies.database.transaction(operation)()
  }

  private requireContract(): { readonly revision: string; readonly generatedAt: string } {
    const contract = this.dependencies.catalog.getStatus().contract
    if (!contract) {
      throw new Error('The catalog contract is unavailable')
    }
    return contract
  }

  private viewsFor(
    products: readonly CatalogProduct[],
    revision: string,
    generatedAt: string
  ): Record<string, ProductStockView> {
    const views: Record<string, ProductStockView> = {}
    const tracked = products.filter((product) => product.trackStock)
    for (const product of products) {
      if (!product.trackStock) {
        views[product.uuid] = { kind: 'untracked' }
      }
    }
    if (tracked.length === 0) {
      return views
    }

    const owner = this.dependencies.owner()
    const warehouseUuid = this.dependencies.bootstrapSnapshot.getWarehouse()?.warehouseUuid ?? null
    const trustedNow = this.dependencies.clock.now()?.now.toISOString() ?? null
    const physicalPresence =
      owner !== null &&
      trustedNow !== null &&
      this.dependencies.offlineSaleAuthorities.findUsable(
        owner.companyUuid,
        owner.deviceUuid,
        trustedNow
      ) !== null

    const uuids = tracked.map((product) => product.uuid)
    const snapshot = this.warehouseSnapshot(uuids, warehouseUuid)
    const sold = owner ? this.soldUnderCatalog(uuids, revision, owner) : new Map<string, number>()

    for (const product of tracked) {
      const warehouse = { quantity: snapshot.get(product.uuid) ?? null, asOf: generatedAt }
      const soldHereUnderCatalog = milliToQuantity(sold.get(product.uuid) ?? 0)

      if (physicalPresence) {
        views[product.uuid] = { kind: 'physical_presence', warehouse, soldHereUnderCatalog }
        continue
      }

      views[product.uuid] = {
        kind: 'allocation',
        warehouse,
        soldHereUnderCatalog,
        reservedHere:
          owner && warehouseUuid && trustedNow
            ? milliToQuantity(
                this.reservedHereMilli(owner, warehouseUuid, product.uuid, trustedNow)
              )
            : null
      }
    }

    return views
  }

  /** The snapshot row for THIS device's assigned warehouse only (never an arbitrary one). */
  private warehouseSnapshot(
    productUuids: readonly string[],
    warehouseUuid: string | null
  ): Map<string, string> {
    const result = new Map<string, string>()
    if (!warehouseUuid) {
      return result
    }
    const placeholders = productUuids.map(() => '?').join(', ')
    const rows = this.dependencies.database
      .prepare(
        `SELECT product_uuid, available_quantity FROM catalog_stock_items
          WHERE warehouse_uuid = ? AND is_active = 1 AND product_uuid IN (${placeholders})`
      )
      .all(warehouseUuid, ...productUuids) as Array<{
      product_uuid: string
      available_quantity: string
    }>
    for (const row of rows) {
      const milli = decimalToMilli(row.available_quantity)
      if (milli !== null) {
        result.set(row.product_uuid, signedMilliToQuantity(milli))
      }
    }
    return result
  }

  /**
   * Tracked quantity sold on this workstation under the installed catalog version. A sale can only
   * commit under the installed revision and revisions never repeat, so this is exactly "since this
   * catalog version was installed" — and re-installing the same revision leaves it true.
   */
  private soldUnderCatalog(
    productUuids: readonly string[],
    revision: string,
    owner: StockViewOwner
  ): Map<string, number> {
    const placeholders = productUuids.map(() => '?').join(', ')
    const rows = this.dependencies.database
      .prepare(
        `SELECT item.product_uuid AS product_uuid, SUM(item.quantity_milli) AS milli
           FROM local_invoice_items item
           JOIN local_invoices invoice ON invoice.local_uuid = item.invoice_local_uuid
          WHERE invoice.catalog_revision = ? AND invoice.company_uuid = ?
            AND invoice.device_uuid = ? AND item.track_stock = 1
            AND item.product_uuid IN (${placeholders})
          GROUP BY item.product_uuid`
      )
      .all(revision, owner.companyUuid, owner.deviceUuid, ...productUuids) as Array<{
      product_uuid: string
      milli: number
    }>
    return new Map(rows.map((row) => [row.product_uuid, row.milli]))
  }

  /** Exact local sellable allocation: the same computation the sale commit's split uses. */
  private reservedHereMilli(
    owner: StockViewOwner,
    warehouseUuid: string,
    productUuid: string,
    trustedNow: string
  ): number {
    return this.dependencies.stockAllocations
      .usableGrantsForProduct({ ...owner, warehouseUuid }, productUuid, trustedNow)
      .reduce(
        (sum, grant) =>
          sum + this.dependencies.stockAllocations.spendableMilli(grant.allocationUuid),
        0
      )
  }
}
