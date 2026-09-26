import { randomUUID } from 'node:crypto'
import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import {
  printerSettingsSchema,
  type PrintJobView,
  type PrintingDispatchInput,
  type PrintingPreviewInput,
  type PrintPreviewOutput,
  type PrinterSettingsOverrides
} from '@shared/contracts/printing.contract'
import { canonicalJson, sha256Hex } from '../services/localSale.fingerprint'
import type { ReceiptAccessService, ReceiptOwner } from './receiptAccess.service'
import type { ReceiptDocumentService } from './receiptDocument.service'
import type { PrinterSettingsService } from './printerSettings.service'
import type { ReceiptRenderWindow } from './receiptRenderer'
import type {
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
  readonly now?: () => Date
  readonly createUuid?: () => string
  readonly unknownTimeoutMs?: number
}

function apiError(
  message: string,
  backendCode: string,
  category: PublicAppError['category'] = 'validation'
): PublicAppError {
  return publicAppErrorSchema.parse({ category, message, backendCode, retryable: false })
}

function toView(row: PrintJobRow): PrintJobView {
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

  private resolveOptions(overrides: PrinterSettingsOverrides): {
    json: string
    sha256: string
    printerName: string | null
    copies: number
    silent: boolean
    paperWidthMm: number
    printableWidthMm: number
    marginTopMm: number
    marginBottomMm: number
    pageLengthProfile: 'content_sized' | 'fixed_page'
    maxContinuousLengthMm: number
    fixedPageHeightMm: number
  } {
    const base = this.dependencies.printerSettings.get()
    const merged = printerSettingsSchema.parse({
      ...base,
      printerName: overrides.printerName ?? base.printerName,
      paperWidthMm: overrides.paperWidthMm ?? base.paperWidthMm,
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

  async preview(owner: ReceiptOwner, input: PrintingPreviewInput): Promise<PrintPreviewOutput> {
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
    const result = this.queue.then(() => this.dispatchInternal(owner, input))
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
   * Receipt-printing plan §D-5 D — main-owned auto-print. Called by `SaleCompletionService` (via
   * `setImmediate`, wrapped so a printing failure can never affect the sale result) ONLY for a
   * fresh, non-replay commit. Builds its own snapshot rather than depending on a renderer preview
   * that may never exist; queued onto the same one-job-at-a-time chain as manual dispatches.
   */
  runAutoPrintForSale(owner: ReceiptOwner, invoiceLocalUuid: string): Promise<PrintJobView | null> {
    const result = this.queue.then(() => this.autoPrintInternal(owner, invoiceLocalUuid))
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async autoPrintInternal(
    owner: ReceiptOwner,
    invoiceLocalUuid: string
  ): Promise<PrintJobView | null> {
    const settings = this.dependencies.printerSettings.get()
    if (!settings.autoPrintAfterSale) {
      return null // auto_not_attempted(disabled) -- no row is written
    }

    const document = { kind: 'sale' as const, invoiceLocalUuid }
    const requestId = `auto-sale:${invoiceLocalUuid}`
    const locale: 'en' | 'ar' = 'en' // main has no renderer locale context here; the reprint (if any) can be requested in the cashier's language

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
      locale,
      overrides: {},
      preview: undefined
    }
    const clientIntentJson = canonicalJson(clientIntent)
    const clientIntentSha256 = sha256Hex(clientIntentJson)

    const built = this.buildDocumentJson(owner, 'sale', invoiceLocalUuid, locale)
    const options = this.resolveOptions({})
    const facts = buildFacts(this.dependencies, 'sale', invoiceLocalUuid)

    const jobUuid = this.createUuid()
    const claimed = this.dependencies.jobs.claim({
      jobUuid,
      requestId,
      clientIntentJson,
      clientIntentSha256,
      trigger: 'auto',
      ownerCompanyUuid: owner.companyUuid,
      ownerDeviceUuid: owner.deviceUuid,
      requestedByUserUuid: owner.userUuid,
      sessionEpochAtClaim: owner.sessionEpoch,
      documentKind: 'sale',
      documentLocalUuid: invoiceLocalUuid,
      documentJson: built.json,
      documentSha256: built.sha256,
      templateVersion: built.templateVersion,
      locale,
      isReprint: built.isReprint,
      factsProjection: facts?.projection ?? null,
      transactionFactsSha256: facts?.sha256 ?? null,
      resolvedOptionsJson: options.json,
      optionsSha256: options.sha256,
      createdAt: this.now().toISOString()
    })

    if (!claimed) {
      // The auto partial-unique index already has a row for this sale -- suppressed, never a
      // second automatic attempt. This is "already_attempted", never "already printed".
      return null
    }

    return this.processClaimedJob(claimed, owner, options, document)
  }

  private async processClaimedJob(
    job: PrintJobRow,
    owner: ReceiptOwner,
    options: ReturnType<typeof this.resolveOptions>,
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
    options: ReturnType<typeof this.resolveOptions>
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
