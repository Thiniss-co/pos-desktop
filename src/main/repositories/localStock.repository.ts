import type { LocalStockMovementRow, StockAuthorization } from '@shared/contracts/sale.contract'
import type { SqliteDatabase } from '../database/connection'

export interface NewLocalStockMovement {
  readonly localUuid: string
  readonly invoiceLocalUuid: string
  readonly itemLocalUuid: string
  readonly productUuid: string
  readonly warehouseUuid: string
  readonly quantityMilli: number
  /** PS4 §8.4: what authorized this movement. Omitted means the legacy allocation shape. */
  readonly stockAuthorization?: StockAuthorization
  readonly createdAt: string
}

function mapRow(row: Record<string, unknown>): LocalStockMovementRow {
  return {
    localUuid: row.local_uuid as string,
    invoiceLocalUuid: row.invoice_local_uuid as string,
    itemLocalUuid: row.item_local_uuid as string,
    productUuid: row.product_uuid as string,
    warehouseUuid: row.warehouse_uuid as string,
    direction: 'out',
    quantityMilli: row.quantity_milli as number,
    syncStatus: row.sync_status as LocalStockMovementRow['syncStatus'],
    syncedAt: null,
    createdAt: row.created_at as string
  }
}

/**
 * CP-1 repository foundation only. `local_stock_movements` is pending-only in Phase 3F — the schema
 * forbids `sync_status = 'synced'` and a non-null `synced_at` by CHECK (plan §3.7); this repository
 * never attempts to write either, so it cannot even offer the unsafe transition. Widening this
 * requires BE-3F-4, out of scope here.
 */
export class LocalStockRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insertMovement(movement: NewLocalStockMovement): LocalStockMovementRow {
    this.database
      .prepare(
        `INSERT INTO local_stock_movements (
           local_uuid, invoice_local_uuid, item_local_uuid, product_uuid, warehouse_uuid,
           direction, quantity_milli, sync_status, stock_authorization, created_at
         ) VALUES (?, ?, ?, ?, ?, 'out', ?, 'pending', ?, ?)`
      )
      .run(
        movement.localUuid,
        movement.invoiceLocalUuid,
        movement.itemLocalUuid,
        movement.productUuid,
        movement.warehouseUuid,
        movement.quantityMilli,
        // PS4: an omitted authorization is the legacy allocation shape, which is what every
        // pre-PS4 movement was by construction.
        movement.stockAuthorization ?? 'allocation',
        movement.createdAt
      )

    const created = this.findByItemLocalUuid(movement.itemLocalUuid)

    if (!created) {
      throw new Error('Local stock movement did not persist')
    }

    return created
  }

  findByItemLocalUuid(itemLocalUuid: string): LocalStockMovementRow | null {
    const row = this.database
      .prepare('SELECT * FROM local_stock_movements WHERE item_local_uuid = ?')
      .get(itemLocalUuid) as Record<string, unknown> | undefined

    return row ? mapRow(row) : null
  }

  movementsForInvoice(invoiceLocalUuid: string): readonly LocalStockMovementRow[] {
    return (
      this.database
        .prepare('SELECT * FROM local_stock_movements WHERE invoice_local_uuid = ?')
        .all(invoiceLocalUuid) as Record<string, unknown>[]
    ).map(mapRow)
  }

  /** Remaining usable (granted minus committed-consumed) quantity is computed by the allocation
   * repository, not here — this repository only ever records the physical `out` side. */
  projectionForProduct(
    productUuid: string,
    warehouseUuid: string
  ): readonly LocalStockMovementRow[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM local_stock_movements WHERE product_uuid = ? AND warehouse_uuid = ?'
        )
        .all(productUuid, warehouseUuid) as Record<string, unknown>[]
    ).map(mapRow)
  }
}
