import { z } from 'zod'

const isoDateTimeSchema = z.iso.datetime({ offset: true })
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const catalogContractSchema = z
  .object({
    revision: revisionSchema,
    generatedAt: isoDateTimeSchema,
    validUntil: isoDateTimeSchema,
    quantityScale: z.literal(3),
    minimumQuantity: z.literal('0.001'),
    maximumQuantity: z.literal('999999.999'),
    maximumUnitPrice: z.literal(1_000_000_000),
    maximumLineTotal: z.literal(900_000_000_000_000),
    maximumInvoiceTotal: z.literal(900_000_000_000_000),
    mixedTaxModePolicy: z.literal('single_invoice_mode')
  })
  .strict()

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
        revision: revisionSchema
      })
      .strict()
  })
  .strict()

export const catalogStatusSchema = z
  .object({
    available: z.boolean(),
    reason: z.enum(['ready', 'missing', 'not-yet-valid', 'expired', 'commercial-access-denied']),
    contract: catalogContractSchema.nullable()
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
  .object({ barcode: z.string().trim().min(3).max(255) })
  .strict()

export const catalogProductPageSchema = z
  .object({
    items: z.array(catalogProductSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    contract: catalogContractSchema
  })
  .strict()

export type CatalogContract = z.infer<typeof catalogContractSchema>
export type CatalogCategory = z.infer<typeof catalogCategorySchema>
export type CatalogProduct = z.infer<typeof catalogProductSchema>
export type CatalogStatus = z.infer<typeof catalogStatusSchema>
export type CatalogSearchInput = z.infer<typeof catalogSearchInputSchema>
export type CatalogProductPage = z.infer<typeof catalogProductPageSchema>
