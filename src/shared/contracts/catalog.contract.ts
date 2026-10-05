import { z } from 'zod'
import { commercialAccessSnapshotSchema } from './license.contract'

const isoDateTimeSchema = z.iso.datetime({ offset: true })
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const catalogContractSchema = z
  .object({
    revision: revisionSchema,
    generatedAt: isoDateTimeSchema,
    validUntil: isoDateTimeSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    currencyExponent: z.number().int().min(0).max(3),
    quantityScale: z.literal(3),
    minimumQuantity: z.literal('0.001'),
    maximumQuantity: z.literal('999999.999'),
    maximumUnitPrice: z.literal(1_000_000_000),
    maximumLineTotal: z.literal(900_000_000_000_000),
    maximumInvoiceTotal: z.literal(900_000_000_000_000),
    // POS improvements, Stage 4: `per_line` is issued only to a register that negotiated
    // `catalog_tax_policy_version=2`; a cart may then mix tax modes and uploads as v4/v5.
    mixedTaxModePolicy: z.enum(['single_invoice_mode', 'per_line']),
    /**
     * Owner expansion Phase E: the register offers this contract carries (its revision covers them).
     * Present only when there is at least one, so a register without offers reads exactly as before.
     */
    offers: z.array(z.lazy(() => catalogOfferSchema)).optional()
  })
  .strict()

export const catalogOfferSchema = z
  .object({
    revisionUuid: z.uuid(),
    name: z.string(),
    type: z.enum(['percentage', 'amount_off', 'fixed_price']),
    value: z.number().int().min(0),
    priority: z.number().int(),
    ordinal: z.number().int().positive(),
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema.nullable(),
    productUuids: z.array(z.uuid())
  })
  .strict()

export type CatalogOfferRecord = z.infer<typeof catalogOfferSchema>

export const catalogCategorySchema = z
  .object({
    uuid: z.uuid(),
    name: z.string()
  })
  .strict()

export const catalogProductSchema = z
  .object({
    uuid: z.uuid(),
    categoryUuid: z.uuid(),
    name: z.string(),
    sku: z.string().nullable(),
    barcode: z.string().nullable(),
    description: z.string().nullable(),
    unit: z.string().nullable(),
    trackStock: z.boolean(),
    availableQuantity: z.string().nullable(),
    price: z
      .object({
        amount: z.number().int().min(0).max(1_000_000_000),
        currency: z.string().regex(/^[A-Z]{3}$/),
        source: z.literal('product_base'),
        revision: revisionSchema,
        validFrom: isoDateTimeSchema,
        validUntil: isoDateTimeSchema
      })
      .strict(),
    tax: z
      .object({
        id: z.uuid().nullable(),
        mode: z.enum(['none', 'inclusive', 'exclusive']),
        rateBasisPoints: z.number().int().min(0).max(10_000),
        revision: revisionSchema,
        /** Stage 4: absent when the installed catalog carries no category for this product. */
        category: z.enum(['standard', 'zero_rated', 'exempt']).optional()
      })
      .strict(),
    /**
     * Owner UX plan P8: the verified thumbnail as a `data:` URL (CSP `img-src 'self' data:`), present
     * only when its bytes are stored locally. Display-only: never part of a cart line or a sale.
     */
    image: z
      .object({ thumbDataUrl: z.string().regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/) })
      .strict()
      .optional()
  })
  .strict()

export const catalogStatusSchema = z
  .object({
    status: z.enum(['fresh', 'cached', 'stale', 'unavailable']),
    isReadable: z.boolean(),
    catalogValid: z.boolean(),
    lastSyncedAt: isoDateTimeSchema.nullable(),
    contract: catalogContractSchema.nullable()
  })
  .strict()

/**
 * The outcome of one authoritative workstation-data refresh.
 *
 * `status` is recalculated after the snapshot is persisted, so the renderer never has to infer
 * freshness from the fact that the call succeeded. `revisionChanged` reports whether the catalog
 * contract revision moved, which is what decides whether an open cart must be rebuilt or cleared
 * rather than silently repriced.
 */
export const catalogRefreshResultSchema = z
  .object({
    status: catalogStatusSchema,
    refreshedAt: isoDateTimeSchema,
    previousRevision: z.string().nullable(),
    revisionChanged: z.boolean(),
    counts: z.record(z.string(), z.number().int().min(0)),
    /**
     * The main-owned commercial-access decision as of the end of the refresh, so a renderer that
     * was blocked can unblock immediately rather than waiting for the pushed access event.
     */
    access: commercialAccessSnapshotSchema,
    /**
     * The **server-derived** license validation timestamp that main persisted. It is reported to
     * the renderer for display only; the renderer can never supply or influence it.
     */
    licenseValidatedAt: z.string().nullable(),
    /**
     * CP-5D-G sanitized diagnostics. Optional so an older caller/result stays valid. These are
     * display/support values only: they name no grant, carry no quantity, and grant the renderer no
     * allocation authority whatsoever — completion always re-resolves usable grants in main.
     */
    allocationDataPresent: z.boolean().optional(),
    stockAllocationRevision: z.number().int().nonnegative().nullable().optional(),
    stockAllocationCount: z.number().int().nonnegative().optional(),
    usableStockAllocationCount: z.number().int().nonnegative().optional()
  })
  .strict()

export const catalogSearchInputSchema = z
  .object({
    query: z.string().trim().max(100).default(''),
    categoryUuid: z.uuid().nullable().default(null),
    limit: z.number().int().min(1).max(50).default(24),
    offset: z.number().int().min(0).max(10_000).default(0)
  })
  .strict()

export const catalogProductIdInputSchema = z.object({ uuid: z.uuid() }).strict()
export const catalogBarcodeInputSchema = z
  .object({ barcode: z.string().trim().min(1).max(255) })
  .strict()

/**
 * POS reliability rev 3 — separated, honestly labelled stock information for one product. Nothing
 * here is an adjusted warehouse balance: the installed snapshot can never prove whether a local
 * effect is already included in it, so snapshot and local activity are reported side by side.
 *
 * - `warehouse`: the server's unreserved quantity for THIS device's assigned warehouse when the
 *   catalog was generated (`asOf`). Historical; later sales and reservations by any till are not
 *   included. `quantity: null` means the snapshot has no stock record for that warehouse.
 * - `soldHereUnderCatalog`: tracked quantity sold on this workstation under the currently installed
 *   catalog version (a purely local fact; never subtracted from `warehouse`).
 * - `reservedHere` (allocation mode): exact spendable allocation, the same figure the sale commit
 *   enforces; `null` when the trusted clock is unavailable.
 */
const stockDecimalSchema = z.string().regex(/^-?\d{1,9}(\.\d{1,3})?$/)
const warehouseSnapshotSchema = z
  .object({
    quantity: stockDecimalSchema.nullable(),
    asOf: isoDateTimeSchema
  })
  .strict()

export const productStockViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('untracked') }).strict(),
  z
    .object({
      kind: z.literal('allocation'),
      warehouse: warehouseSnapshotSchema,
      soldHereUnderCatalog: stockDecimalSchema,
      reservedHere: stockDecimalSchema.nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal('physical_presence'),
      warehouse: warehouseSnapshotSchema,
      soldHereUnderCatalog: stockDecimalSchema
    })
    .strict()
])

export const catalogProductPageSchema = z
  .object({
    items: z.array(catalogProductSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    contract: catalogContractSchema,
    /** Rev 3: read in the same SQLite read transaction as `items` and `contract`. */
    stock: z.record(z.string(), productStockViewSchema).optional()
  })
  .strict()

/** Rev 3: a product read for selling carries the catalog revision it was read under. */
export const catalogProductForSaleSchema = z
  .object({
    product: catalogProductSchema,
    revision: revisionSchema,
    stock: productStockViewSchema
  })
  .strict()

export const catalogCustomerSchema = z
  .object({
    uuid: z.uuid(),
    name: z.string(),
    phone: z.string().nullable(),
    /**
     * POS improvements, Stage 2: present (true) only for a customer created on this register whose
     * create request the server has not accepted yet. Selling to it is allowed; the sale uploads
     * after the customer is accepted.
     */
    pendingSync: z.literal(true).optional()
  })
  .strict()

export const catalogCustomerSearchInputSchema = z
  .object({
    query: z.string().trim().max(100).default(''),
    limit: z.number().int().min(1).max(50).default(24),
    offset: z.number().int().min(0).max(10_000).default(0)
  })
  .strict()

export const catalogCustomerPageSchema = z
  .object({
    items: z.array(catalogCustomerSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative()
  })
  .strict()

export const paymentMethodTypeSchema = z.enum([
  'cash',
  'card',
  'bank_transfer',
  'wallet',
  'loyalty',
  'other'
])

export const catalogPaymentMethodSchema = z
  .object({
    uuid: z.uuid(),
    name: z.string(),
    code: z.string().nullable(),
    type: paymentMethodTypeSchema.nullable(),
    isActive: z.boolean(),
    allowsChange: z.boolean(),
    requiresReference: z.boolean(),
    sortOrder: z.number().int()
  })
  .strict()

/**
 * The result of one main-owned, single-transaction snapshot read used by checkout validation.
 * Never exposed over IPC directly; only `CheckoutPreviewService` reads it. A missing product or a
 * requested customer that fails to resolve fails the whole snapshot (`null`, never partial); an
 * unresolved payment method uuid is simply absent from `paymentMethods` so `PAYMENT_METHOD_UNKNOWN`
 * can be raised one layer up instead of here.
 */
export const checkoutResolutionSchema = z
  .object({
    contract: catalogContractSchema,
    products: z.array(catalogProductSchema),
    paymentMethods: z.array(catalogPaymentMethodSchema),
    customer: catalogCustomerSchema.nullable(),
    snapshotRevision: revisionSchema
  })
  .strict()

export const catalogBarcodeLookupSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('found'),
      product: catalogProductSchema,
      /** Rev 3: the catalog revision this lookup was read under (optional for older callers). */
      revision: revisionSchema.optional()
    })
    .strict(),
  z.object({ outcome: z.literal('not-found') }).strict(),
  z.object({ outcome: z.literal('ambiguous') }).strict(),
  z.object({ outcome: z.literal('stale-catalog') }).strict(),
  z.object({ outcome: z.literal('unavailable-catalog') }).strict()
])

export type CatalogContract = z.infer<typeof catalogContractSchema>
export type CatalogCategory = z.infer<typeof catalogCategorySchema>
export type CatalogProduct = z.infer<typeof catalogProductSchema>
export type CatalogStatus = z.infer<typeof catalogStatusSchema>
export type CatalogRefreshResult = z.infer<typeof catalogRefreshResultSchema>
export type CatalogSearchInput = z.infer<typeof catalogSearchInputSchema>
export type CatalogProductPage = z.infer<typeof catalogProductPageSchema>
export type CatalogCustomer = z.infer<typeof catalogCustomerSchema>
export type CatalogCustomerSearchInput = z.infer<typeof catalogCustomerSearchInputSchema>
export type CatalogCustomerPage = z.infer<typeof catalogCustomerPageSchema>
export type PaymentMethodType = z.infer<typeof paymentMethodTypeSchema>
export type CatalogPaymentMethod = z.infer<typeof catalogPaymentMethodSchema>
export type CheckoutResolution = z.infer<typeof checkoutResolutionSchema>
export type CatalogBarcodeLookup = z.infer<typeof catalogBarcodeLookupSchema>
export type ProductStockView = z.infer<typeof productStockViewSchema>
export type CatalogProductForSale = z.infer<typeof catalogProductForSaleSchema>
