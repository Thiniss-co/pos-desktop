import {
  catalogCategorySchema,
  catalogContractSchema,
  catalogProductSchema,
  type CatalogCategory,
  type CatalogContract,
  type CatalogProduct,
  type CatalogSearchInput
} from '@shared/contracts/catalog.contract'
import type { SqliteDatabase } from '../database/connection'

interface CatalogProductRow {
  readonly uuid: string
  readonly category_uuid: string
  readonly name: string
  readonly sku: string | null
  readonly barcode: string | null
  readonly description: string | null
  readonly unit: string | null
  readonly track_stock: number
  readonly available_quantity: string | null
  readonly price_amount: number
  readonly price_currency: string
  readonly price_source: string
  readonly price_revision: string
  readonly price_valid_from: string
  readonly price_valid_until: string
  readonly tax_uuid: string | null
  readonly tax_mode: string
  readonly tax_rate_basis_points: number
  readonly tax_revision: string
}

interface CatalogContractRow {
  readonly revision: string
  readonly generated_at: string
  readonly valid_until: string
  readonly quantity_scale: number
  readonly minimum_quantity: string
  readonly maximum_quantity: string
  readonly maximum_unit_price: number
  readonly maximum_line_total: number
  readonly maximum_invoice_total: number
  readonly mixed_tax_mode_policy: string
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

export class CatalogRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getContract(): CatalogContract | null {
    const row = this.database.prepare('SELECT * FROM catalog_metadata WHERE id = 1').get() as
      CatalogContractRow | undefined

    return row
      ? catalogContractSchema.parse({
          revision: row.revision,
          generatedAt: row.generated_at,
          validUntil: row.valid_until,
          quantityScale: row.quantity_scale,
          minimumQuantity: row.minimum_quantity,
          maximumQuantity: row.maximum_quantity,
          maximumUnitPrice: row.maximum_unit_price,
          maximumLineTotal: row.maximum_line_total,
          maximumInvoiceTotal: row.maximum_invoice_total,
          mixedTaxModePolicy: row.mixed_tax_mode_policy
        })
      : null
  }

  listCategories(): CatalogCategory[] {
    const rows = this.database
      .prepare(
        `
          SELECT DISTINCT category.uuid, category.name
          FROM catalog_categories AS category
          INNER JOIN catalog_products AS product ON product.category_uuid = category.uuid
          WHERE category.is_active = 1
            AND product.is_active = 1
            AND product.status = 'active'
            AND product.price_amount IS NOT NULL
            AND product.tax_mode IS NOT NULL
          ORDER BY category.search_name ASC, category.uuid ASC
        `
      )
      .all() as Array<{ readonly uuid: string; readonly name: string }>

    return rows.map((row) => catalogCategorySchema.parse(row))
  }

  searchProducts(
    input: CatalogSearchInput,
    now: string
  ): { items: CatalogProduct[]; total: number } {
    const clauses = [
      'product.is_active = 1',
      "product.status = 'active'",
      'category.is_active = 1',
      'product.price_amount IS NOT NULL',
      'product.tax_mode IS NOT NULL',
      'julianday(product.price_valid_from) <= julianday(?)',
      'julianday(product.price_valid_until) > julianday(?)'
    ]
    const values: Array<string | number> = [now, now]
    const query = normalizeSearch(input.query)

    if (input.categoryUuid) {
      clauses.push('product.category_uuid = ?')
      values.push(input.categoryUuid)
    }

    if (query) {
      clauses.push(
        `(
          (product.search_name >= ? AND product.search_name < ?)
          OR (product.search_sku >= ? AND product.search_sku < ?)
          OR product.barcode = ?
        )`
      )
      const upperBound = `${query}\uffff`
      values.push(query, upperBound, query, upperBound, input.query)
    }

    const where = clauses.join(' AND ')
    const total = this.database
      .prepare(
        `
          SELECT COUNT(*) AS total
          FROM catalog_products AS product
          INNER JOIN catalog_categories AS category ON category.uuid = product.category_uuid
          WHERE ${where}
        `
      )
      .get(...values) as { readonly total: number }
    const rows = this.database
      .prepare(
        `
          ${this.productSelect()}
          WHERE ${where}
          ORDER BY product.search_name ASC, product.uuid ASC
          LIMIT ? OFFSET ?
        `
      )
      .all(...values, input.limit, input.offset) as CatalogProductRow[]

    return { items: rows.map((row) => this.mapProduct(row)), total: total.total }
  }

  getProduct(uuid: string, now: string): CatalogProduct | null {
    const row = this.database
      .prepare(
        `
          ${this.productSelect()}
          WHERE product.uuid = ?
            AND product.is_active = 1
            AND product.status = 'active'
            AND category.is_active = 1
            AND julianday(product.price_valid_from) <= julianday(?)
            AND julianday(product.price_valid_until) > julianday(?)
        `
      )
      .get(uuid, now, now) as CatalogProductRow | undefined

    return row ? this.mapProduct(row) : null
  }

  findProductsByBarcode(barcode: string, now: string): CatalogProduct[] {
    const rows = this.database
      .prepare(
        `
          ${this.productSelect()}
          WHERE product.uuid IN (
            SELECT uuid FROM catalog_products WHERE barcode = ?
            UNION
            SELECT product_uuid FROM catalog_product_barcodes
            WHERE barcode = ? AND is_active = 1
          )
            AND product.is_active = 1
            AND product.status = 'active'
            AND category.is_active = 1
            AND julianday(product.price_valid_from) <= julianday(?)
            AND julianday(product.price_valid_until) > julianday(?)
          ORDER BY product.uuid ASC
        `
      )
      .all(barcode, barcode, now, now) as CatalogProductRow[]

    return rows.map((row) => this.mapProduct(row))
  }

  private productSelect(): string {
    return `
      SELECT
        product.uuid, product.category_uuid, product.name, product.sku, product.barcode,
        product.description, product.unit, product.track_stock,
        (
          SELECT stock.available_quantity FROM catalog_stock_items AS stock
          WHERE stock.product_uuid = product.uuid AND stock.is_active = 1
          ORDER BY stock.uuid ASC LIMIT 1
        ) AS available_quantity,
        product.price_amount, product.price_currency, product.price_source,
        product.price_revision, product.price_valid_from, product.price_valid_until,
        product.tax_uuid, product.tax_mode, product.tax_rate_basis_points, product.tax_revision
      FROM catalog_products AS product
      INNER JOIN catalog_categories AS category ON category.uuid = product.category_uuid
    `
  }

  private mapProduct(row: CatalogProductRow): CatalogProduct {
    return catalogProductSchema.parse({
      uuid: row.uuid,
      categoryUuid: row.category_uuid,
      name: row.name,
      sku: row.sku,
      barcode: row.barcode,
      description: row.description,
      unit: row.unit,
      trackStock: row.track_stock === 1,
      availableQuantity: row.available_quantity,
      price: {
        amount: row.price_amount,
        currency: row.price_currency,
        source: row.price_source,
        revision: row.price_revision,
        validFrom: row.price_valid_from,
        validUntil: row.price_valid_until
      },
      tax: {
        id: row.tax_uuid,
        mode: row.tax_mode,
        rateBasisPoints: row.tax_rate_basis_points,
        revision: row.tax_revision
      }
    })
  }
}
