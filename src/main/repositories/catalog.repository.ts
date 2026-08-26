import {
  catalogCategorySchema,
  catalogContractSchema,
  catalogCustomerPageSchema,
  catalogCustomerSchema,
  catalogPaymentMethodSchema,
  catalogProductSchema,
  type CatalogCategory,
  type CatalogContract,
  type CatalogCustomer,
  type CatalogCustomerPage,
  type CatalogCustomerSearchInput,
  type CatalogPaymentMethod,
  type CatalogProduct,
  type CatalogSearchInput
} from '@shared/contracts/catalog.contract'
import {
  catalogPrefixUpperBound,
  normalizeCatalogBarcode,
  normalizeCatalogSearch
} from '@shared/catalog/normalization'
import { z } from 'zod'
import type { SqliteDatabase } from '../database/connection'

const catalogManifestSchema = z
  .object({
    categories: z.number().int().nonnegative(),
    products: z.number().int().nonnegative(),
    barcodes: z.number().int().nonnegative(),
    priceRevisions: z.number().int().nonnegative(),
    taxRevisions: z.number().int().nonnegative(),
    paymentMethods: z.number().int().nonnegative(),
    customers: z.number().int().nonnegative()
  })
  .strict()

type CatalogManifest = z.infer<typeof catalogManifestSchema>

export interface CatalogSnapshot {
  readonly contract: CatalogContract
  readonly fetchedAt: string
  readonly manifest: CatalogManifest
}

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
  readonly fetched_at: string
  readonly expected_counts_json: string
  readonly is_complete: number
}

const LIST_LIMIT = 100

export class CatalogRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getContract(): CatalogContract | null {
    return this.getSnapshot()?.contract ?? null
  }

  getSnapshot(): CatalogSnapshot | null {
    const row = this.database.prepare('SELECT * FROM catalog_metadata WHERE id = 1').get() as
      CatalogContractRow | undefined

    if (!row || row.is_complete !== 1) {
      return null
    }

    try {
      return {
        contract: catalogContractSchema.parse({
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
        }),
        fetchedAt: z.iso.datetime({ offset: true }).parse(row.fetched_at),
        manifest: catalogManifestSchema.parse(JSON.parse(row.expected_counts_json))
      }
    } catch {
      return null
    }
  }

  isSnapshotIntact(snapshot: CatalogSnapshot): boolean {
    const count = (sql: string): number =>
      (this.database.prepare(sql).get() as { readonly total: number }).total
    const actual: CatalogManifest = {
      categories: count('SELECT COUNT(*) AS total FROM catalog_categories'),
      products: count('SELECT COUNT(*) AS total FROM catalog_products'),
      barcodes: count('SELECT COUNT(*) AS total FROM catalog_product_barcodes'),
      priceRevisions: count(`
        SELECT COUNT(*) AS total FROM catalog_products
        WHERE is_active = 1 AND status = 'active'
          AND price_amount IS NOT NULL AND price_currency IS NOT NULL AND price_revision IS NOT NULL
          AND price_valid_from IS NOT NULL AND price_valid_until IS NOT NULL
      `),
      taxRevisions: count(`
        SELECT COUNT(*) AS total FROM catalog_products
        WHERE is_active = 1 AND status = 'active'
          AND tax_mode IS NOT NULL AND tax_rate_basis_points IS NOT NULL AND tax_revision IS NOT NULL
      `),
      paymentMethods: count('SELECT COUNT(*) AS total FROM payment_methods'),
      customers: count('SELECT COUNT(*) AS total FROM customers')
    }

    if (JSON.stringify(actual) !== JSON.stringify(snapshot.manifest)) {
      return false
    }

    const invalidRows = count(`
      SELECT COUNT(*) AS total
      FROM catalog_products AS product
      LEFT JOIN catalog_categories AS category ON category.uuid = product.category_uuid
      CROSS JOIN catalog_metadata AS metadata
      WHERE metadata.id = 1
        AND product.is_active = 1
        AND product.status = 'active'
        AND (
          product.category_uuid IS NULL
          OR category.uuid IS NULL
          OR category.is_active = 0
          OR product.price_valid_from > metadata.generated_at
          OR product.price_valid_until <> metadata.valid_until
          OR product.price_amount NOT BETWEEN 0 AND metadata.maximum_unit_price
          OR product.price_currency NOT GLOB '[A-Z][A-Z][A-Z]'
          OR product.tax_mode NOT IN ('none', 'inclusive', 'exclusive')
          OR product.tax_rate_basis_points NOT BETWEEN 0 AND 10000
          OR (product.tax_mode = 'none' AND (product.tax_uuid IS NOT NULL OR product.tax_rate_basis_points <> 0))
          OR (product.tax_mode <> 'none' AND product.tax_uuid IS NULL)
        )
    `)
    const danglingBarcodes = count(`
      SELECT COUNT(*) AS total
      FROM catalog_product_barcodes AS barcode
      LEFT JOIN catalog_products AS product ON product.uuid = barcode.product_uuid
      WHERE product.uuid IS NULL
    `)

    return invalidRows === 0 && danglingBarcodes === 0
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
          LIMIT ?
        `
      )
      .all(LIST_LIMIT) as Array<{ readonly uuid: string; readonly name: string }>

    return rows.map((row) => catalogCategorySchema.parse(row))
  }

  searchProducts(input: CatalogSearchInput): { items: CatalogProduct[]; total: number } {
    const clauses = [
      'product.is_active = 1',
      "product.status = 'active'",
      'category.is_active = 1',
      'product.price_amount IS NOT NULL',
      'product.tax_mode IS NOT NULL'
    ]
    const values: Array<string | number> = []
    const query = normalizeCatalogSearch(input.query)

    if (input.categoryUuid) {
      clauses.push('product.category_uuid = ?')
      values.push(input.categoryUuid)
    }

    if (query) {
      const upperBound = catalogPrefixUpperBound(query)
      clauses.push(`
        product.uuid IN (
          SELECT uuid FROM catalog_products WHERE search_name >= ? AND search_name < ?
          UNION
          SELECT uuid FROM catalog_products WHERE search_sku >= ? AND search_sku < ?
          UNION
          SELECT uuid FROM catalog_products WHERE barcode = ?
        )
      `)
      values.push(query, upperBound, query, upperBound, normalizeCatalogBarcode(input.query))
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

  getProduct(uuid: string): CatalogProduct | null {
    const row = this.database
      .prepare(
        `
          ${this.productSelect()}
          WHERE product.uuid = ?
            AND product.is_active = 1
            AND product.status = 'active'
            AND category.is_active = 1
        `
      )
      .get(uuid) as CatalogProductRow | undefined

    return row ? this.mapProduct(row) : null
  }

  findProductsByBarcode(barcode: string): CatalogProduct[] {
    const exactBarcode = normalizeCatalogBarcode(barcode)
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
          ORDER BY product.uuid ASC
        `
      )
      .all(exactBarcode, exactBarcode) as CatalogProductRow[]

    return rows.map((row) => this.mapProduct(row))
  }

  listPaymentMethods(): CatalogPaymentMethod[] {
    const rows = this.database
      .prepare(
        `
          SELECT id AS uuid, name, code, type
          FROM payment_methods
          WHERE is_active = 1
          ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC
          LIMIT ?
        `
      )
      .all(LIST_LIMIT) as Array<{
      readonly uuid: string
      readonly name: string
      readonly code: string | null
      readonly type: string | null
    }>

    return rows.map((row) => catalogPaymentMethodSchema.parse(row))
  }

  searchCustomers(input: CatalogCustomerSearchInput): CatalogCustomerPage {
    const query = normalizeCatalogSearch(input.query)
    const values: Array<string | number> = []
    let match = ''

    if (query) {
      const upperBound = catalogPrefixUpperBound(query)
      match = `
        AND customer.id IN (
          SELECT id FROM customers WHERE is_active = 1 AND search_name >= ? AND search_name < ?
          UNION
          SELECT id FROM customers WHERE is_active = 1 AND search_phone >= ? AND search_phone < ?
        )
      `
      values.push(query, upperBound, query, upperBound)
    }

    const total = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM customers AS customer WHERE customer.is_active = 1 ${match}`
      )
      .get(...values) as { readonly total: number }
    const rows = this.database
      .prepare(
        `
          SELECT id AS uuid, name, phone
          FROM customers AS customer
          WHERE customer.is_active = 1 ${match}
          ORDER BY customer.search_name ASC, customer.id ASC
          LIMIT ? OFFSET ?
        `
      )
      .all(...values, input.limit, input.offset) as Array<{
      readonly uuid: string
      readonly name: string
      readonly phone: string | null
    }>

    return catalogCustomerPageSchema.parse({
      items: rows.map((row) => catalogCustomerSchema.parse(row)),
      total: total.total,
      limit: input.limit,
      offset: input.offset
    })
  }

  getCustomer(uuid: string): CatalogCustomer | null {
    const row = this.database
      .prepare('SELECT id AS uuid, name, phone FROM customers WHERE id = ? AND is_active = 1')
      .get(uuid) as
      { readonly uuid: string; readonly name: string; readonly phone: string | null } | undefined

    return row ? catalogCustomerSchema.parse(row) : null
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
