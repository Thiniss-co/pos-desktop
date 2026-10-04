import { randomUUID } from 'node:crypto'
import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import {
  printerSettingsSchema,
  type PrintJobView,
  type PrintingDispatchInput,
  type PrintingPreviewInput,
  type PrintPreviewOutput,
  type PrinterSettings,
  type PrinterSettingsOverrides,
  MAX_PRINTABLE_WIDTH_MM
} from '@shared/contracts/printing.contract'
import { canonicalJson, sha256Hex } from '../services/localSale.fingerprint'
import type { ReceiptAccessService, ReceiptOwner } from './receiptAccess.service'
import type { ReceiptDocumentService } from './receiptDocument.service'
import type { PrinterSettingsService } from './printerSettings.service'
import type { ReceiptRenderWindow } from './receiptRenderer'
import jsQR from 'jsqr'
import type { ReceiptDocument } from '@shared/receipt/receiptDocument'
import { decodeZatcaPhase1Qr } from '@shared/receipt/fiscalQr'
import { decodeTransactionReferenceQr } from '@shared/receipt/transactionQr'
import type { FiscalContextService, ReceiptQr } from './fiscalContext.service'
import type {
  NewPrintJob,
  PrintJobRow,
  PrintJobStatus,
  ReceiptPrintJobRepository
} from '../repositories/receiptPrintJob.repository'
import { buildRefundFacts, buildSaleFacts, type TransactionFacts } from './transactionFacts'
import { buildReceiptHtml } from './receiptHtml'
import type { LocalSaleRepository } from '../repositories/localSale.repository'
import type { LocalRefundRepository } from '../repositories/localRefund.repository'
import type { ReceiptProfileRepository } from '../repositories/receiptProfile.repository'

/**
 * Receipt-printing plan §D-5 — dispatch orchestration. Every mutating step reuses
 * `ReceiptPrintJobRepository`'s single conditional-UPDATE methods, so `changes=0` (a stale/duplicate
 * event) is always distinguishable from a real transition.
 *
 * ## Serialization (the "one render window at a time" worker, simplified)
 *
 * Every `dispatch()` call is queued onto one `Promise` chain (`this.queue`), so at most one job is
 * ever being prepared/dispatched at a time, using the one shared `ReceiptRenderWindow`. This
 * implements the plan's "at most one live render window" worker model directly, without a separate
 * lease/timer class: because processing is fully synchronous JavaScript between `await` points and
 * the queue guarantees no two jobs interleave, there is no second job that could observe or mutate
 * another job's row while it runs. Cancellation (`cancelJob`) is honest about this: only a job still
 * `queued` (has not yet reached the front of the chain) can be cancelled; once a job's turn starts,
 * it runs to completion (matching "cancel while preparing" being a narrow, best-effort window even
 * in the full lease design).
 */

export interface ReceiptPrintingDependencies {
  readonly jobs: ReceiptPrintJobRepository
  readonly access: ReceiptAccessService
  readonly documents: ReceiptDocumentService
  readonly printerSettings: PrinterSettingsService
  readonly localSale: Pick<
    LocalSaleRepository,
    'itemsForInvoice' | 'paymentsForInvoice' | 'findInvoiceByLocalUuid'
  >
  readonly localRefunds: Pick<
    LocalRefundRepository,
    'itemsForRefund' | 'paymentsForRefund' | 'findByLocalUuid'
  >
  /** Optional: absent only in narrow unit-test fakes that do not exercise branding. Used solely to
   *  resolve a frozen `header.logo.sha256` to actual bytes at render time (plan §D-11) — never to
   *  look up "the current" profile for a sale/refund document. */
  readonly receiptProfile?: Pick<ReceiptProfileRepository, 'getAsset'>
  readonly getPrinters: () => Promise<Array<{ name: string; displayName: string }>>
  readonly getRenderWindow: () => ReceiptRenderWindow
  /**
   * POS improvements, Stage 6: the QR each sale/refund receipt must carry, recomputed from its frozen
   * facts. Without it (narrow unit fakes) a sale or refund job can never pass the QR gate.
   */
  readonly fiscalQr?: Pick<FiscalContextService, 'expectedSaleQr' | 'expectedRefundQr'>
  readonly now?: () => Date
  readonly createUuid?: () => string
  readonly unknownTimeoutMs?: number
}

/** The final print options of one job, resolved from settings plus the job's own overrides. */
export interface ResolvedPrintOptions {
  readonly json: string
  readonly sha256: string
  readonly printerName: string | null
  readonly copies: number
  readonly silent: boolean
  readonly paperWidthMm: number
  readonly printableWidthMm: number
  readonly marginTopMm: number
  readonly marginBottomMm: number
  readonly pageLengthProfile: 'content_sized' | 'fixed_page'
  readonly maxContinuousLengthMm: number
  readonly fixedPageHeightMm: number
}

/** POS improvements, Stage 7: an AUTO job ready to be claimed inside an admission transaction. */
export interface PreparedAutoJob {
  readonly document: { readonly kind: 'sale'; readonly invoiceLocalUuid: string }
  readonly options: ResolvedPrintOptions
  readonly job: NewPrintJob
}

function apiError(
  message: string,
  backendCode: string,
  category: PublicAppError['category'] = 'validation'
): PublicAppError {
  return publicAppErrorSchema.parse({ category, message, backendCode, retryable: false })
}

export function toView(row: PrintJobRow): PrintJobView {
  const phase: PrintJobView['phase'] =
    row.status === 'queued' || row.status === 'preparing' || row.status === 'dispatching'
      ? (row.status as 'queued' | 'preparing' | 'dispatching')
      : null
  const status: PrintJobView['status'] =
    phase !== null ? 'in_progress' : (row.status as PrintJobView['status'])

  return {
    jobUuid: row.jobUuid,
    status,
    phase,
    failureCode: row.failureCode,
    cancelOrigin: row.cancelOrigin,
    createdAt: row.createdAt,
    dispatchedAt: row.dispatchedAt,
    finishedAt: row.finishedAt,
    isReprint: row.isReprint
  }
}

function buildFacts(
  deps: ReceiptPrintingDependencies,
  documentKind: 'sale' | 'refund' | 'test',
  documentLocalUuid: string
): TransactionFacts | null {
  if (documentKind === 'sale') {
    const invoice = deps.localSale.findInvoiceByLocalUuid(documentLocalUuid)
    if (!invoice) return null
    return buildSaleFacts({
      invoice,
      items: deps.localSale.itemsForInvoice(documentLocalUuid),
      payments: deps.localSale.paymentsForInvoice(documentLocalUuid)
    })
  }
  if (documentKind === 'refund') {
    const refund = deps.localRefunds.findByLocalUuid(documentLocalUuid)
    if (!refund) return null
    return buildRefundFacts({
      refund,
      items: deps.localRefunds.itemsForRefund(documentLocalUuid),
      payments: deps.localRefunds.paymentsForRefund(documentLocalUuid)
    })
  }
  return null
}

export class ReceiptPrintingService {
  private readonly now: () => Date
  private readonly createUuid: () => string
  private readonly unknownTimeoutMs: number
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly dependencies: ReceiptPrintingDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.createUuid = dependencies.createUuid ?? (() => randomUUID())
    this.unknownTimeoutMs = dependencies.unknownTimeoutMs ?? 90_000
  }

  reconcileStartup(): void {
    this.dependencies.jobs.reconcileStartup(this.now().toISOString())
  }

  listPrinters(): Promise<Array<{ name: string; displayName: string }>> {
    return this.dependencies.getPrinters()
  }

  private resolveOptions(overrides: PrinterSettingsOverrides): ResolvedPrintOptions {
    return this.resolveOptionsFrom(this.dependencies.printerSettings.get(), overrides)
  }

  private resolveOptionsFrom(
    base: PrinterSettings,
    overrides: PrinterSettingsOverrides
  ): ResolvedPrintOptions {
    const paperWidthMm = overrides.paperWidthMm ?? base.paperWidthMm
    const merged = printerSettingsSchema.parse({
      ...base,
      printerName: overrides.printerName ?? base.printerName,
      paperWidthMm,
      // Stage 6: never wider than the paper actually is (the 72 mm default on a 58 mm roll printed
      // past the paper edge).
      printableWidthMm: Math.min(base.printableWidthMm, MAX_PRINTABLE_WIDTH_MM[paperWidthMm]),
      defaultCopies: overrides.copies ?? base.defaultCopies
    })
    const json = canonicalJson(merged)
    return {
      json,
      sha256: sha256Hex(json),
      printerName: merged.printerName,
      copies: merged.defaultCopies,
      silent: merged.dispatchMode === 'direct',
      paperWidthMm: merged.paperWidthMm,
      printableWidthMm: merged.printableWidthMm,
      marginTopMm: merged.marginTopMm,
      marginBottomMm: merged.marginBottomMm,
      pageLengthProfile: merged.pageLengthProfile,
      maxContinuousLengthMm: merged.maxContinuousLengthMm,
      fixedPageHeightMm: merged.fixedPageHeightMm
    }
  }

  private buildDocumentJson(
    owner: ReceiptOwner,
    documentKind: 'sale' | 'refund' | 'test',
    documentLocalUuid: string,
    locale: 'en' | 'ar'
  ): { json: string; sha256: string; isReprint: boolean; templateVersion: number } {
    const isReprint =
      documentKind !== 'test' &&
      this.dependencies.jobs.hasSubmittedOrUnknown(documentKind, documentLocalUuid)

    if (documentKind === 'sale') {
      const row = this.dependencies.localSale.findInvoiceByLocalUuid(documentLocalUuid)
      const owned = this.dependencies.access.assertSaleDocument(owner, row)
      void owned
      const doc = this.dependencies.documents.buildSaleDocument(
        documentLocalUuid,
        locale,
        isReprint
      )
      const json = canonicalJson(doc)
      return { json, sha256: sha256Hex(json), isReprint, templateVersion: doc.templateVersion }
    }
    if (documentKind === 'refund') {
      const row = this.dependencies.localRefunds.findByLocalUuid(documentLocalUuid)
      this.dependencies.access.assertRefundDocument(owner, row)
      const doc = this.dependencies.documents.buildRefundDocument(
        documentLocalUuid,
        locale,
        isReprint
      )
      const json = canonicalJson(doc)
      return { json, sha256: sha256Hex(json), isReprint, templateVersion: doc.templateVersion }
    }
    const doc = this.dependencies.documents.buildTestDocument(locale, owner.companyUuid)
    const json = canonicalJson(doc)
    return { json, sha256: sha256Hex(json), isReprint: false, templateVersion: doc.templateVersion }
  }

  /** Resolves a frozen `header.logo` to an inline `data:` URL, from the company-scoped asset
   *  store. Never rebuilds or re-derives what to include from anything but the frozen flag. */
  private resolveLogoDataUrl(
    companyUuid: string,
    logo: { sha256: string; included: boolean } | null
  ): string | null {
    if (!logo?.included || !this.dependencies.receiptProfile) {
      return null
    }
    const asset = this.dependencies.receiptProfile.getAsset(companyUuid, logo.sha256)
    if (!asset?.content) {
      return null
    }
    return `data:${asset.mediaType};base64,${asset.content.toString('base64')}`
  }

  /**
   * POS improvements, Stage 7: a preview renders on the same shared window as print jobs, so it
   * joins the same one-at-a-time chain. With automatic printing on by default, a cashier opening the
   * preview while the sale's AUTO job is preparing otherwise interleaved two renders on one window,
   * and both waited forever.
   */
  preview(owner: ReceiptOwner, input: PrintingPreviewInput): Promise<PrintPreviewOutput> {
    return this.enqueue(() => this.previewInternal(owner, input))
  }

  private async previewInternal(
    owner: ReceiptOwner,
    input: PrintingPreviewInput
  ): Promise<PrintPreviewOutput> {
    const document = input.document
    const documentLocalUuid =
      document.kind === 'test'
        ? 'test'
        : document.kind === 'sale'
          ? document.invoiceLocalUuid
          : document.refundLocalUuid

    const built = this.buildDocumentJson(owner, document.kind, documentLocalUuid, input.locale)
    const options = this.resolveOptions(input.overrides)
    const doc = JSON.parse(built.json)
    const logoDataUrl = this.resolveLogoDataUrl(owner.companyUuid, doc.header?.logo ?? null)

    const html = buildReceiptHtml(
      doc,
      { printableWidthMm: options.printableWidthMm },
      { logoDataUrl }
    )
    const renderWindow = this.dependencies.getRenderWindow()
    const plan = await renderWindow.render({
      html,
      paperWidthMm: options.paperWidthMm,
      printableWidthMm: options.printableWidthMm,
      marginTopMm: options.marginTopMm,
      marginBottomMm: options.marginBottomMm,
      pageLengthProfile: options.pageLengthProfile,
      maxContinuousLengthMm: options.maxContinuousLengthMm,
      fixedPageHeightMm: options.fixedPageHeightMm
    })
    const pngDataUrl = await renderWindow.capturePreviewPage()

    const priorJob = this.dependencies.jobs.findLatestForDocument(document.kind, documentLocalUuid)

    return {
      previewDocumentSha256: built.sha256,
      previewOptionsSha256: options.sha256,
      pages: [{ pngDataUrl, widthMm: options.paperWidthMm, heightMm: plan.pageHeightUm / 1000 }],
      pageCount: plan.pageCount,
      pageHeightMm: plan.pageHeightUm / 1000,
      unusedLastPageMm: plan.unusedLastPageUm === null ? null : plan.unusedLastPageUm / 1000,
      isReprint: built.isReprint,
      priorJobSummary: priorJob ? toView(priorJob) : null,
      notices: []
    }
  }

  getJob(owner: ReceiptOwner, requestId: string): PrintJobView {
    const row = this.dependencies.jobs.findByRequestId(requestId)
    if (
      !row ||
      row.ownerCompanyUuid !== owner.companyUuid ||
      row.ownerDeviceUuid !== owner.deviceUuid
    ) {
      throw apiError('This print job could not be found.', 'receipt_not_found')
    }
    return toView(row)
  }

  cancelJob(owner: ReceiptOwner, requestId: string): PrintJobView {
    const row = this.dependencies.jobs.findByRequestId(requestId)
    if (
      !row ||
      row.ownerCompanyUuid !== owner.companyUuid ||
      row.ownerDeviceUuid !== owner.deviceUuid
    ) {
      throw apiError('This print job could not be found.', 'receipt_not_found')
    }
    this.dependencies.jobs.markCancelledFromQueue(
      requestId === row.requestId ? row.jobUuid : row.jobUuid,
      this.now().toISOString()
    )
    return toView(this.dependencies.jobs.findByJobUuid(row.jobUuid)!)
  }

  latestForDocument(
    owner: ReceiptOwner,
    documentKind: 'sale' | 'refund' | 'test',
    documentLocalUuid: string
  ): PrintJobView | null {
    if (documentKind === 'sale') {
      this.dependencies.access.assertSaleDocument(
        owner,
        this.dependencies.localSale.findInvoiceByLocalUuid(documentLocalUuid)
      )
    } else if (documentKind === 'refund') {
      this.dependencies.access.assertRefundDocument(
        owner,
        this.dependencies.localRefunds.findByLocalUuid(documentLocalUuid)
      )
    }
    const row = this.dependencies.jobs.findLatestForDocument(documentKind, documentLocalUuid)
    return row ? toView(row) : null
  }

  /** Serializes dispatch calls onto one queue (the "one render window at a time" worker). */
  dispatch(owner: ReceiptOwner, input: PrintingDispatchInput): Promise<PrintJobView> {
    return this.enqueue(() => this.dispatchInternal(owner, input))
  }

  /** Runs `work` after everything already on the shared render window's chain. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    // Swallow the rejection on the queue chain itself so one failed job never wedges the next.
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async dispatchInternal(
    owner: ReceiptOwner,
    input: PrintingDispatchInput
  ): Promise<PrintJobView> {
    const document = input.document
    const documentLocalUuid =
      document.kind === 'test'
        ? 'test'
        : document.kind === 'sale'
          ? document.invoiceLocalUuid
          : document.refundLocalUuid

    // Step 2: replay lookup, before any fresh build.
    const existing = this.dependencies.jobs.findByRequestId(input.requestId)
    const clientIntent = {
      v: 1,
      requestId: input.requestId,
      owner: {
        companyUuid: owner.companyUuid,
        deviceUuid: owner.deviceUuid,
        userUuid: owner.userUuid
      },
      trigger: 'manual' as const,
      document,
      locale: input.locale,
      overrides: input.overrides,
      preview: input.preview
    }
    const clientIntentJson = canonicalJson(clientIntent)
    const clientIntentSha256 = sha256Hex(clientIntentJson)

    if (existing) {
      if (
        existing.ownerCompanyUuid !== owner.companyUuid ||
        existing.ownerDeviceUuid !== owner.deviceUuid
      ) {
        throw apiError('This receipt could not be found.', 'receipt_not_found')
      }
      if (existing.clientIntentSha256 === clientIntentSha256) {
        return toView(existing) // read-only replay
      }
      throw apiError(
        'This print request conflicts with an earlier one under the same id.',
        'print_request_conflict',
        'conflict'
      )
    }

    // Step 3: fresh checks.
    const built = this.buildDocumentJson(owner, document.kind, documentLocalUuid, input.locale)
    if (built.sha256 !== input.preview.previewDocumentSha256) {
      throw apiError(
        'The receipt preview is stale. Preview it again before printing.',
        'receipt_preview_stale',
        'conflict'
      )
    }
    const options = this.resolveOptions(input.overrides)
    if (options.sha256 !== input.preview.previewOptionsSha256) {
      throw apiError(
        'The receipt preview is stale. Preview it again before printing.',
        'receipt_preview_stale',
        'conflict'
      )
    }

    const facts = buildFacts(this.dependencies, document.kind, documentLocalUuid)

    // Step 4: claim.
    const jobUuid = this.createUuid()
    const nowIso = this.now().toISOString()
    const claimed = this.dependencies.jobs.claim({
      jobUuid,
      requestId: input.requestId,
      clientIntentJson,
      clientIntentSha256,
      trigger: 'manual',
      ownerCompanyUuid: owner.companyUuid,
      ownerDeviceUuid: owner.deviceUuid,
      requestedByUserUuid: owner.userUuid,
      sessionEpochAtClaim: owner.sessionEpoch,
      documentKind: document.kind,
      documentLocalUuid,
      documentJson: built.json,
      documentSha256: built.sha256,
      templateVersion: built.templateVersion,
      locale: input.locale,
      isReprint: built.isReprint,
      factsProjection: facts?.projection ?? null,
      transactionFactsSha256: facts?.sha256 ?? null,
      resolvedOptionsJson: options.json,
      optionsSha256: options.sha256,
      createdAt: nowIso
    })

    if (!claimed) {
      // A UNIQUE violation on the reservation or auto index; re-check which.
      const afterRace = this.dependencies.jobs.findByRequestId(input.requestId)
      if (afterRace) {
        return afterRace.clientIntentSha256 === clientIntentSha256
          ? toView(afterRace)
          : (() => {
              throw apiError(
                'This print request conflicts with an earlier one under the same id.',
                'print_request_conflict',
                'conflict'
              )
            })()
      }
      throw apiError('This receipt is already printing.', 'print_document_busy', 'conflict')
    }

    return this.processClaimedJob(claimed, owner, options, document)
  }

  /**
   * POS improvements, Stage 7 — everything one AUTO job needs, built synchronously from the intent's
   * FROZEN printer snapshot (never today's settings). Automatic printing is always silent to the
   * snapshot's printer, whatever the manual dispatch mode. Nothing is written here.
   */
  prepareAutoJob(
    owner: ReceiptOwner,
    input: {
      readonly invoiceLocalUuid: string
      readonly locale: 'en' | 'ar'
      readonly settings: PrinterSettings
    }
  ): PreparedAutoJob {
    const document = { kind: 'sale' as const, invoiceLocalUuid: input.invoiceLocalUuid }
    const requestId = `auto-sale:${input.invoiceLocalUuid}`
    const clientIntent = {
      v: 1,
      requestId,
      owner: {
        companyUuid: owner.companyUuid,
        deviceUuid: owner.deviceUuid,
        userUuid: owner.userUuid
      },
      trigger: 'auto' as const,
      document,
      locale: input.locale,
      overrides: {},
      preview: undefined
    }
    const clientIntentJson = canonicalJson(clientIntent)
    const built = this.buildDocumentJson(owner, 'sale', input.invoiceLocalUuid, input.locale)
    const options = this.resolveOptionsFrom({ ...input.settings, dispatchMode: 'direct' }, {})
    const facts = buildFacts(this.dependencies, 'sale', input.invoiceLocalUuid)

    return {
      document,
      options,
      job: {
        jobUuid: this.createUuid(),
        requestId,
        clientIntentJson,
        clientIntentSha256: sha256Hex(clientIntentJson),
        trigger: 'auto',
        ownerCompanyUuid: owner.companyUuid,
        ownerDeviceUuid: owner.deviceUuid,
        requestedByUserUuid: owner.userUuid,
        // The CURRENT session epoch: the fence before dispatch compares against it.
        sessionEpochAtClaim: owner.sessionEpoch,
        documentKind: 'sale',
        documentLocalUuid: input.invoiceLocalUuid,
        documentJson: built.json,
        documentSha256: built.sha256,
        templateVersion: built.templateVersion,
        locale: input.locale,
        isReprint: built.isReprint,
        factsProjection: facts?.projection ?? null,
        transactionFactsSha256: facts?.sha256 ?? null,
        resolvedOptionsJson: options.json,
        optionsSha256: options.sha256,
        createdAt: this.now().toISOString()
      }
    }
  }

  /**
   * Inserts the prepared AUTO job. The caller's admission transaction owns it: `null` (the AUTO
   * partial-unique index already holds a job for this sale) must roll the admission back.
   */
  claimAutoJob(prepared: PreparedAutoJob): PrintJobRow | null {
    return this.dependencies.jobs.claim(prepared.job)
  }

  /**
   * Runs an admitted AUTO job on the one-job chain: preparation (render, layout, rendered-QR check)
   * and then the synchronous fence and dispatch, exactly as for a manual print. A job that fails
   * before dispatch is never re-admitted (its admission row exists); `outcome_unknown` is never resent.
   */
  runAdmittedAutoJob(
    job: PrintJobRow,
    owner: ReceiptOwner,
    prepared: PreparedAutoJob
  ): Promise<PrintJobView> {
    return this.enqueue(() =>
      this.processClaimedJob(job, owner, prepared.options, prepared.document)
    )
  }

  private async processClaimedJob(
    job: PrintJobRow,
    owner: ReceiptOwner,
    options: ResolvedPrintOptions,
    document: PrintingDispatchInput['document']
  ): Promise<PrintJobView> {
    const leaseId = this.createUuid()
    const preparingChanges = this.dependencies.jobs.beginPreparing(
      job.jobUuid,
      leaseId,
      this.now().toISOString()
    )
    if (preparingChanges === 0) {
      return toView(this.dependencies.jobs.findByJobUuid(job.jobUuid)!) // cancelled underneath us
    }

    try {
      const printers = await this.dependencies.getPrinters()
      if (printers.length === 0) {
        this.dependencies.jobs.markFailedBeforeDispatch(
          job.jobUuid,
          leaseId,
          'PRINTER_NONE_INSTALLED',
          this.now().toISOString()
        )
        return toView(this.dependencies.jobs.findByJobUuid(job.jobUuid)!)
      }
      if (options.printerName && !printers.some((p) => p.name === options.printerName)) {
        this.dependencies.jobs.markFailedBeforeDispatch(
          job.jobUuid,
          leaseId,
          'PRINTER_NOT_FOUND',
          this.now().toISOString()
        )
        return toView(this.dependencies.jobs.findByJobUuid(job.jobUuid)!)
      }

      const doc = JSON.parse(job.documentJson)
      const logoDataUrl = this.resolveLogoDataUrl(job.ownerCompanyUuid, doc.header?.logo ?? null)
      const html = buildReceiptHtml(
        doc,
        { printableWidthMm: options.printableWidthMm },
        { logoDataUrl }
      )
      const renderWindow = this.dependencies.getRenderWindow()

      let plan = await renderWindow.render({
        html,
        paperWidthMm: options.paperWidthMm,
        printableWidthMm: options.printableWidthMm,
        marginTopMm: options.marginTopMm,
        marginBottomMm: options.marginBottomMm,
        pageLengthProfile: options.pageLengthProfile,
        maxContinuousLengthMm: options.maxContinuousLengthMm,
        fixedPageHeightMm: options.fixedPageHeightMm
      })
      let verify = await renderWindow.verifyWithPdf()
      if (!verify.matches) {
        plan = await renderWindow.render(
          {
            html,
            paperWidthMm: options.paperWidthMm,
            printableWidthMm: options.printableWidthMm,
            marginTopMm: options.marginTopMm,
            marginBottomMm: options.marginBottomMm,
            pageLengthProfile: options.pageLengthProfile,
            maxContinuousLengthMm: options.maxContinuousLengthMm,
            fixedPageHeightMm: options.fixedPageHeightMm
          },
          true
        )
        verify = await renderWindow.verifyWithPdf()
        if (!verify.matches) {
          this.dependencies.jobs.markFailedBeforeDispatch(
            job.jobUuid,
            leaseId,
            'RECEIPT_LAYOUT_UNVERIFIED',
            this.now().toISOString()
          )
          return toView(this.dependencies.jobs.findByJobUuid(job.jobUuid)!)
        }
      }

      const layoutJson = canonicalJson(plan)
      this.dependencies.jobs.recordLayout(job.jobUuid, leaseId, layoutJson, sha256Hex(layoutJson))

      // POS improvements, Stage 6 (Phase P): the RENDERED QR must decode to exactly the payload the
      // frozen facts produce, and parse as that type. Done here, before the fence below, so the fence
      // stays synchronous. A failure is positively never dispatched; the sale/refund is untouched.
      if (job.documentKind !== 'test') {
        const verifiedSha = await this.verifyRenderedQr(job, doc, renderWindow)
        if (verifiedSha === null) {
          this.dependencies.jobs.markFailedBeforeDispatch(
            job.jobUuid,
            leaseId,
            'RECEIPT_QR_INVALID',
            this.now().toISOString()
          )
          return toView(this.dependencies.jobs.findByJobUuid(job.jobUuid)!)
        }
        this.dependencies.jobs.recordQrVerified(job.jobUuid, leaseId, verifiedSha)
      }

      // Final gate (plan §D-5 C step 8): re-check owner, permission and document state/facts.
      const gateFailure = this.finalGate(owner, document, job)
      if (gateFailure) {
        this.dependencies.jobs.markFailedBeforeDispatch(
          job.jobUuid,
          leaseId,
          gateFailure,
          this.now().toISOString()
        )
        return toView(this.dependencies.jobs.findByJobUuid(job.jobUuid)!)
      }

      const dispatchToken = this.createUuid()
      const dispatchChanges = this.dependencies.jobs.beginDispatching(
        job.jobUuid,
        leaseId,
        dispatchToken,
        this.now().toISOString()
      )
      if (dispatchChanges === 0) {
        return toView(this.dependencies.jobs.findByJobUuid(job.jobUuid)!)
      }

      return await this.dispatchAndClassify(job.jobUuid, dispatchToken, renderWindow, options)
    } catch {
      this.dependencies.jobs.markFailedBeforeDispatch(
        job.jobUuid,
        leaseId,
        'RENDER_FAILED',
        this.now().toISOString()
      )
      return toView(this.dependencies.jobs.findByJobUuid(job.jobUuid)!)
    }
  }

  /** The sha256 of the decoded QR when it is exactly the expected payload and type, else `null`. */
  private async verifyRenderedQr(
    job: PrintJobRow,
    doc: ReceiptDocument,
    renderWindow: ReceiptRenderWindow
  ): Promise<string | null> {
    const expected = this.expectedQr(job)
    const embedded = doc.fiscal?.qr ?? null
    if (
      expected === null ||
      embedded === null ||
      embedded.type !== expected.type ||
      embedded.payload !== expected.payload
    ) {
      return null
    }
    const bitmap = await renderWindow.captureQrBitmap()
    if (bitmap === null) {
      return null
    }
    const decoded = jsQR(bitmap.data, bitmap.width, bitmap.height)?.data ?? null
    if (decoded === null || decoded !== expected.payload) {
      return null
    }
    if (expected.type === 'zatca-p1') {
      if (decodeZatcaPhase1Qr(decoded) === null) {
        return null
      }
    } else {
      const reference = decodeTransactionReferenceQr(decoded)
      if (
        reference === null ||
        reference.id !== job.documentLocalUuid ||
        reference.doc !== job.documentKind
      ) {
        return null
      }
    }
    return sha256Hex(decoded)
  }

  private expectedQr(job: PrintJobRow): ReceiptQr | null {
    const fiscalQr = this.dependencies.fiscalQr
    if (!fiscalQr) {
      return null
    }
    if (job.documentKind === 'sale') {
      const invoice = this.dependencies.localSale.findInvoiceByLocalUuid(job.documentLocalUuid)
      return invoice
        ? fiscalQr.expectedSaleQr({
            invoiceLocalUuid: invoice.localUuid,
            companyUuid: invoice.companyUuid,
            soldAt: invoice.soldAt,
            grandTotalAmount: invoice.grandTotalAmount,
            taxTotalAmount: invoice.taxTotalAmount,
            currency: invoice.currency,
            currencyExponent: invoice.currencyExponent
          })
        : null
    }
    if (job.documentKind === 'refund') {
      const refund = this.dependencies.localRefunds.findByLocalUuid(job.documentLocalUuid)
      return refund
        ? fiscalQr.expectedRefundQr({
            refundLocalUuid: refund.localUuid,
            companyUuid: refund.companyUuid,
            refundedAt: refund.refundedAt,
            grandTotalAmount: refund.grandTotalAmount,
            taxTotalAmount: refund.taxTotalAmount,
            currency: refund.currency,
            currencyExponent: refund.currencyExponent
          })
        : null
    }
    return null
  }

  private finalGate(
    owner: ReceiptOwner,
    document: PrintingDispatchInput['document'],
    job: PrintJobRow
  ): string | null {
    try {
      const fresh = this.dependencies.access.resolveCaller()
      if (
        fresh.companyUuid !== owner.companyUuid ||
        fresh.deviceUuid !== owner.deviceUuid ||
        fresh.userUuid !== owner.userUuid ||
        fresh.sessionEpoch !== job.sessionEpochAtClaim
      ) {
        return 'SESSION_CHANGED'
      }
    } catch {
      return 'ACCESS_REVOKED'
    }

    if (document.kind === 'sale') {
      const row = this.dependencies.localSale.findInvoiceByLocalUuid(document.invoiceLocalUuid)
      if (!row || row.companyUuid !== owner.companyUuid) {
        return 'DOCUMENT_STATE_CHANGED'
      }
    } else if (document.kind === 'refund') {
      const row = this.dependencies.localRefunds.findByLocalUuid(document.refundLocalUuid)
      if (!row || row.companyUuid !== owner.companyUuid || row.submissionState !== 'accepted') {
        return 'DOCUMENT_STATE_CHANGED'
      }
    }

    if (job.transactionFactsSha256) {
      const facts = buildFacts(this.dependencies, job.documentKind, job.documentLocalUuid)
      if (!facts || facts.sha256 !== job.transactionFactsSha256) {
        return 'TRANSACTION_FACTS_MISMATCH'
      }
    }

    return null
  }

  private async dispatchAndClassify(
    jobUuid: string,
    dispatchToken: string,
    renderWindow: ReceiptRenderWindow,
    options: ResolvedPrintOptions
  ): Promise<PrintJobView> {
    let settled = false

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!settled) {
          this.dependencies.jobs.markOutcomeUnknownFromTimeout(
            jobUuid,
            dispatchToken,
            this.now().toISOString()
          )
        }
        resolve()
      }, this.unknownTimeoutMs)
    })

    const dispatchPromise = renderWindow
      .dispatchPrint({
        deviceName: options.printerName,
        silent: options.silent,
        copies: options.copies
      })
      .then(({ success, failureReason }) => {
        settled = true
        const now = this.now().toISOString()
        if (success) {
          this.dependencies.jobs.markSubmitted(jobUuid, dispatchToken, now)
          return
        }
        if (failureReason === 'Print job canceled' && options.silent === false) {
          this.dependencies.jobs.markCancelledFromDialog(jobUuid, dispatchToken, failureReason, now)
          return
        }
        if (
          failureReason === 'Invalid printer settings' ||
          /invalid.*device ?name/i.test(failureReason)
        ) {
          this.dependencies.jobs.markFailedFromCallback(
            jobUuid,
            dispatchToken,
            'OS_REJECTED_SETTINGS',
            failureReason,
            now
          )
          return
        }
        this.dependencies.jobs.markOutcomeUnknownFromCallback(
          jobUuid,
          dispatchToken,
          failureReason,
          now
        )
      })
      .catch(() => {
        settled = true
        this.dependencies.jobs.markFailedFromSyncThrow(
          jobUuid,
          dispatchToken,
          this.now().toISOString()
        )
      })

    await Promise.race([dispatchPromise, timeoutPromise])
    return toView(this.dependencies.jobs.findByJobUuid(jobUuid)!)
  }
}

export type { PrintJobStatus }
