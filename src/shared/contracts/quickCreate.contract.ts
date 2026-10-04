import { z } from 'zod'

/** POS improvements, Stage 1 — the register quick-create entity kinds. */
export const quickCreateEntitySchema = z.enum(['customer', 'supplier', 'product'])
export type QuickCreateEntity = z.infer<typeof quickCreateEntitySchema>

/**
 * What the signed-in user may quick-create on this register, decided in main from the cached
 * bootstrap (capability + plan feature + permission + snapshot owner). Advisory for the UI; main
 * re-checks on every create, and the backend route middleware is the authority.
 */
export const quickCreateAccessSchema = z
  .object({
    available: z.boolean(),
    customer: z.boolean(),
    supplier: z.boolean(),
    product: z.boolean()
  })
  .strict()
export type QuickCreateAccess = z.infer<typeof quickCreateAccessSchema>

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Zod 4 tracks key optionality on the inferred schema type; a widened annotation would lose it
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()

const requiredName = z.string().trim().min(1).max(255)

/** POS improvements, Stage 2 — the renderer's quick-create inputs (validated again in main). */
export const quickCreateCustomerInputSchema = z
  .object({
    name: requiredName,
    phone: optionalText(50),
    email: z
      .union([z.literal(''), z.email().max(255)])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
    taxNumber: optionalText(100),
    address: optionalText(1000),
    notes: optionalText(2000)
  })
  .strict()
export type QuickCreateCustomerInput = z.input<typeof quickCreateCustomerInputSchema>

export const quickCreateSupplierInputSchema = z
  .object({
    name: requiredName,
    contactPerson: optionalText(255),
    phone: optionalText(50),
    email: z
      .union([z.literal(''), z.email().max(255)])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
    taxNumber: optionalText(100)
  })
  .strict()
export type QuickCreateSupplierInput = z.input<typeof quickCreateSupplierInputSchema>

export const quickCreateProductInputSchema = z
  .object({
    name: requiredName,
    sku: optionalText(255),
    barcode: optionalText(255),
    /** Decimal string in the catalog currency, e.g. "3.50"; converted to minor units in main. */
    price: z
      .string()
      .trim()
      .regex(/^\d{1,9}(\.\d{1,4})?$/),
    categoryUuid: z.uuid(),
    taxUuid: z.uuid().nullable(),
    taxMode: z.enum(['none', 'inclusive', 'exclusive']),
    unit: optionalText(50),
    trackStock: z.boolean().optional()
  })
  .strict()
  .refine((value) => (value.taxMode === 'none') === (value.taxUuid === null), {
    message: 'A taxed product needs a tax; an untaxed product has none.',
    path: ['taxUuid']
  })
export type QuickCreateProductInput = z.input<typeof quickCreateProductInputSchema>

export const quickCreateRequestKeyInputSchema = z.object({ requestKey: z.uuid() }).strict()

export const quickCreateResubmitInputSchema = z.discriminatedUnion('entityType', [
  z
    .object({
      entityType: z.literal('customer'),
      requestKey: z.uuid(),
      fields: quickCreateCustomerInputSchema
    })
    .strict(),
  z
    .object({
      entityType: z.literal('supplier'),
      requestKey: z.uuid(),
      fields: quickCreateSupplierInputSchema
    })
    .strict(),
  z
    .object({
      entityType: z.literal('product'),
      requestKey: z.uuid(),
      fields: quickCreateProductInputSchema
    })
    .strict()
])
export type QuickCreateResubmitInput = z.input<typeof quickCreateResubmitInputSchema>

/**
 * What the register shows for one create request. `status` distinguishes "Pending sync" from
 * "Ready to sell": a product is sellable only once the installed catalog carries its issued revision.
 */
export const quickCreateStatusSchema = z.enum([
  'pending_sync',
  'waiting_for_creator',
  'blocked',
  'refused',
  'conflict',
  'superseded',
  'created',
  'awaiting_catalog',
  'ready_to_sell'
])
export type QuickCreateStatus = z.infer<typeof quickCreateStatusSchema>

export const quickCreateRecordSchema = z
  .object({
    requestKey: z.uuid(),
    entityType: quickCreateEntitySchema,
    entityUuid: z.uuid(),
    name: z.string().max(255),
    status: quickCreateStatusSchema,
    /** Created by the signed-in user (details of other users' requests are still shown by name). */
    mine: z.boolean(),
    resultCode: z.string().max(64).nullable(),
    resultMessage: z.string().max(500).nullable(),
    resultFields: z.record(z.string(), z.array(z.string())).nullable(),
    traceId: z.string().max(128).nullable(),
    sendCount: z.number().int().nonnegative(),
    createdAt: z.string(),
    resubmittedAs: z.uuid().nullable(),
    actions: z.object({ retry: z.boolean(), reassign: z.boolean(), resubmit: z.boolean() }).strict()
  })
  .strict()
export type QuickCreateRecord = z.infer<typeof quickCreateRecordSchema>

export const quickCreateRecordListSchema = z.array(quickCreateRecordSchema).max(200)

export const quickCreateProductOptionsSchema = z
  .object({
    currency: z.string().length(3),
    currencyExponent: z.number().int().min(0).max(4),
    categories: z.array(z.object({ uuid: z.uuid(), name: z.string() }).strict()),
    taxes: z.array(z.object({ uuid: z.uuid(), name: z.string(), rateLabel: z.string() }).strict())
  })
  .strict()
export type QuickCreateProductOptions = z.infer<typeof quickCreateProductOptionsSchema>
