import { z } from 'zod'

/**
 * Receipt-printing plan (rev 5) — printing and company-receipt-branding contracts shared by main
 * (persistence, rendering, IPC handlers) and renderer (store, service, preview dialog).
 */

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

export const receiptDocumentRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sale'), invoiceLocalUuid: z.uuid() }).strict(),
  z.object({ kind: z.literal('refund'), refundLocalUuid: z.uuid() }).strict(),
  z.object({ kind: z.literal('test') }).strict()
])
export type ReceiptDocumentRef = z.infer<typeof receiptDocumentRefSchema>

// ---------------------------------------------------------------------------------------------
// Workstation printer settings (BD-2: any active authenticated user may configure these; they
// carry no company branding).
// ---------------------------------------------------------------------------------------------

export const PAPER_WIDTHS_MM = [58, 80] as const
export type PaperWidthMm = (typeof PAPER_WIDTHS_MM)[number]
export const paperWidthMmSchema = z.union([z.literal(58), z.literal(80)])

export const PAGE_LENGTH_PROFILES = ['content_sized', 'fixed_page'] as const
export type PageLengthProfile = (typeof PAGE_LENGTH_PROFILES)[number]

export const DISPATCH_MODES = ['direct', 'system_dialog'] as const
export type DispatchMode = (typeof DISPATCH_MODES)[number]

export const printerSettingsSchema = z
  .object({
    printerName: z.string().max(256).nullable(),
    paperWidthMm: paperWidthMmSchema,
    printableWidthMm: z.number().int().min(40).max(80),
    marginTopMm: z.number().min(0).max(10),
    marginBottomMm: z.number().min(0).max(25),
    pageLengthProfile: z.enum(PAGE_LENGTH_PROFILES),
    maxContinuousLengthMm: z.number().int().min(200).max(3000),
    fixedPageHeightMm: z.number().int().min(80).max(3000),
    defaultCopies: z.number().int().min(1).max(3),
    dispatchMode: z.enum(DISPATCH_MODES),
    autoPrintAfterSale: z.boolean()
  })
  .strict()
export type PrinterSettings = z.infer<typeof printerSettingsSchema>

export const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
  printerName: null,
  paperWidthMm: 80,
  printableWidthMm: 72,
  marginTopMm: 2,
  marginBottomMm: 6,
  pageLengthProfile: 'content_sized',
  maxContinuousLengthMm: 1000,
  fixedPageHeightMm: 297,
  defaultCopies: 1,
  dispatchMode: 'direct',
  autoPrintAfterSale: false
}

export const printerSettingsOverridesSchema = z
  .object({
    copies: z.number().int().min(1).max(3).optional(),
    printerName: z.string().max(256).optional(),
    paperWidthMm: paperWidthMmSchema.optional()
  })
  .strict()
export type PrinterSettingsOverrides = z.infer<typeof printerSettingsOverridesSchema>

export const printerInfoSchema = z
  .object({
    name: z.string(),
    displayName: z.string(),
    state: z.enum(['idle', 'busy', 'stopped']).optional()
  })
  .strict()
export type PrinterInfo = z.infer<typeof printerInfoSchema>

// ---------------------------------------------------------------------------------------------
// Print requests (D-5)
// ---------------------------------------------------------------------------------------------

export const printTriggerSchema = z.enum(['manual', 'test'])
export type PrintTrigger = z.infer<typeof printTriggerSchema>

export const printPreviewRefSchema = z
  .object({
    previewDocumentSha256: z.string().length(64),
    previewOptionsSha256: z.string().length(64)
  })
  .strict()

export const printingPreviewInputSchema = z
  .object({
    document: receiptDocumentRefSchema,
    locale: z.enum(['en', 'ar']),
    overrides: printerSettingsOverridesSchema
  })
  .strict()
export type PrintingPreviewInput = z.infer<typeof printingPreviewInputSchema>

export const printingDispatchInputSchema = z
  .object({
    requestId: z.uuid(),
    document: receiptDocumentRefSchema,
    locale: z.enum(['en', 'ar']),
    overrides: printerSettingsOverridesSchema,
    preview: printPreviewRefSchema
  })
  .strict()
export type PrintingDispatchInput = z.infer<typeof printingDispatchInputSchema>

export const printingGetJobInputSchema = z.object({ requestId: z.uuid() }).strict()
export const printingCancelJobInputSchema = z.object({ requestId: z.uuid() }).strict()
export const printingLatestForDocumentInputSchema = z
  .object({ document: receiptDocumentRefSchema })
  .strict()

export const PRINT_JOB_STATUSES = [
  'in_progress',
  'submitted',
  'cancelled',
  'failed_before_dispatch',
  'outcome_unknown'
] as const
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number]

export const PRINT_JOB_PHASES = ['queued', 'preparing', 'dispatching'] as const
export type PrintJobPhase = (typeof PRINT_JOB_PHASES)[number]

export const printJobViewSchema = z
  .object({
    jobUuid: z.uuid(),
    status: z.enum(PRINT_JOB_STATUSES),
    phase: z.enum(PRINT_JOB_PHASES).nullable(),
    failureCode: z.string().nullable(),
    cancelOrigin: z.enum(['queue', 'dialog']).nullable(),
    createdAt: z.string(),
    dispatchedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    isReprint: z.boolean()
  })
  .strict()
export type PrintJobView = z.infer<typeof printJobViewSchema>

export const printingLatestForDocumentOutputSchema = printJobViewSchema
  .extend({ autoAttempted: z.boolean() })
  .nullable()

export const printPreviewPageSchema = z
  .object({
    pngDataUrl: z.string(),
    widthMm: z.number(),
    heightMm: z.number()
  })
  .strict()

export const printPreviewOutputSchema = z
  .object({
    previewDocumentSha256: z.string().length(64),
    previewOptionsSha256: z.string().length(64),
    pages: z.array(printPreviewPageSchema),
    pageCount: z.number().int().min(1),
    pageHeightMm: z.number(),
    unusedLastPageMm: z.number().nullable(),
    isReprint: z.boolean(),
    priorJobSummary: printJobViewSchema.nullable(),
    notices: z.array(z.string())
  })
  .strict()
export type PrintPreviewOutput = z.infer<typeof printPreviewOutputSchema>

// ---------------------------------------------------------------------------------------------
// Company receipt profile mirror (D-11)
// ---------------------------------------------------------------------------------------------

export const receiptProfileLogoRefSchema = z
  .object({
    sha256: z.string().length(64),
    mediaType: z.string(),
    widthPx: z.number().int(),
    heightPx: z.number().int(),
    byteLength: z.number().int()
  })
  .strict()

export const receiptProfileVersionSchema = z
  .object({
    versionUuid: z.uuid(),
    revision: z.number().int().min(1),
    addressLines: z.array(z.string()),
    phone: z.string().nullable(),
    taxIdentifierLabel: z.string().nullable(),
    taxIdentifierValue: z.string().nullable(),
    footerLines: z.array(z.string()),
    logo: receiptProfileLogoRefSchema.nullable()
  })
  .strict()
export type ReceiptProfileVersion = z.infer<typeof receiptProfileVersionSchema>

export const receiptProfileGetOutputSchema = z
  .object({
    capability: z.enum(['unsupported', 'supported']),
    canManage: z.boolean(),
    profile: receiptProfileVersionSchema.nullable(),
    logo: z
      .object({ present: z.boolean(), thumbnailPngDataUrl: z.string().nullable() })
      .strict()
      .nullable()
  })
  .strict()
export type ReceiptProfileGetOutput = z.infer<typeof receiptProfileGetOutputSchema>

export const receiptProfileChooseLogoOutputSchema = z
  .object({
    sha256: z.string().length(64),
    thumbnailPngDataUrl: z.string()
  })
  .strict()
export type ReceiptProfileChooseLogoOutput = z.infer<typeof receiptProfileChooseLogoOutputSchema>

export const receiptProfileLogoActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('remove') }).strict(),
  z.object({ action: z.literal('set'), sha256: z.string().length(64) }).strict()
])

export const receiptProfilePublishInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    fields: z
      .object({
        addressLines: z.array(z.string().max(80)).max(4),
        phone: z.string().max(40).nullable(),
        taxIdentifierLabel: z.string().max(24).nullable(),
        taxIdentifierValue: z.string().max(40).nullable(),
        footerLines: z.array(z.string().max(80)).max(3)
      })
      .strict(),
    logo: receiptProfileLogoActionSchema
  })
  .strict()
export type ReceiptProfilePublishInput = z.infer<typeof receiptProfilePublishInputSchema>
