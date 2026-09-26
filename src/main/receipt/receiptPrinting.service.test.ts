import { describe, expect, it, vi, type Mock } from 'vitest'
import { ReceiptPrintingService, type ReceiptPrintingDependencies } from './receiptPrinting.service'
import type { ReceiptAccessService, ReceiptOwner } from './receiptAccess.service'
import type { ReceiptDocumentService } from './receiptDocument.service'
import type { PrinterSettingsService } from './printerSettings.service'
import type { ReceiptRenderWindow } from './receiptRenderer'
import type {
  NewPrintJob,
  PrintJobRow,
  ReceiptPrintJobRepository
} from '../repositories/receiptPrintJob.repository'
import type { PrintingDispatchInput, PrintPreviewOutput } from '@shared/contracts/printing.contract'
import type { LocalInvoiceRow } from '@shared/contracts/sale.contract'
import type { LocalRefundRow } from '@shared/contracts/refund.contract'
import type { ReceiptDocument } from '@shared/receipt/receiptDocument'

const OWNER: ReceiptOwner = {
  companyUuid: 'company-1',
  deviceUuid: 'device-1',
  userUuid: 'user-1',
  sessionEpoch: 1
}

function invoiceRow(overrides: Partial<LocalInvoiceRow> = {}): LocalInvoiceRow {
  return {
    localUuid: 'inv-1',
    attemptKey: 'attempt-1',
    offlineNumber: 'POS-1',
    remoteUuid: null,
    serverNumber: null,
    syncStatus: 'synced',
    syncAttempts: 0,
    lastSyncError: null,
    syncedAt: null,
    companyUuid: 'company-1',
    branchUuid: 'branch-1',
    warehouseUuid: 'warehouse-1',
    deviceUuid: 'device-1',
    userUuid: 'user-1',
    shiftUuid: 'shift-1',
    commitSessionEpoch: 1,
    catalogRevision: 'rev-1',
    intentFingerprint: 'fp-1',
    customerUuid: null,
    currency: 'USD',
    currencyExponent: 2,
    taxMode: 'exclusive',
    invoiceDiscountType: null,
    invoiceDiscountValue: 0,
    subtotalAmount: 1000,
    discountTotalAmount: 0,
    taxTotalAmount: 0,
    grandTotalAmount: 1000,
    paidTotalAmount: 1000,
    changeDueAmount: 0,
    dueAmount: 0,
    soldAt: '2026-01-01T00:00:00.000Z',
    connectivityStateAtSale: 'online',
    soldWhileOffline: false,
    notes: null,
    commercialSnapshotJson: '{}',
    uploadPayloadVersion: 3,
    offlineSaleAuthorityUuid: null,
    stockAuthorizationPolicy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

/** An in-memory fake of ReceiptPrintJobRepository's public surface, faithful to the real
 *  conditional-UPDATE/`changes` semantics the service depends on. */
class FakeJobRepository {
  rows = new Map<string, PrintJobRow>()

  claim(job: NewPrintJob): PrintJobRow | null {
    if ([...this.rows.values()].some((r) => r.requestId === job.requestId)) return null
    if (
      [...this.rows.values()].some(
        (r) =>
          r.documentKind === job.documentKind &&
          r.documentLocalUuid === job.documentLocalUuid &&
          ['queued', 'preparing', 'dispatching'].includes(r.status)
      )
    ) {
      return null
    }
    if (
      job.trigger === 'auto' &&
      [...this.rows.values()].some(
        (r) =>
          r.trigger === 'auto' &&
          r.documentKind === job.documentKind &&
          r.documentLocalUuid === job.documentLocalUuid
      )
    ) {
      return null
    }
    const row: PrintJobRow = {
      ...job,
      layoutJson: null,
      layoutSha256: null,
      status: 'queued',
      cancelOrigin: null,
      workerLeaseId: null,
      dispatchToken: null,
      failureCode: null,
      osCallbackAt: null,
      osCallbackSuccess: null,
      osCallbackReason: null,
      preparingAt: null,
      dispatchedAt: null,
      unknownAt: null,
      finishedAt: null,
      windowReleasedAt: null
    }
    this.rows.set(row.jobUuid, row)
    return row
  }

  findByJobUuid(jobUuid: string): PrintJobRow | null {
    return this.rows.get(jobUuid) ?? null
  }
  findByRequestId(requestId: string): PrintJobRow | null {
    return [...this.rows.values()].find((r) => r.requestId === requestId) ?? null
  }
  findLatestForDocument(documentKind: string, documentLocalUuid: string): PrintJobRow | null {
    const matches = [...this.rows.values()]
      .filter((r) => r.documentKind === documentKind && r.documentLocalUuid === documentLocalUuid)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return matches[0] ?? null
  }
  hasSubmittedOrUnknown(documentKind: string, documentLocalUuid: string): boolean {
    return [...this.rows.values()].some(
      (r) =>
        r.documentKind === documentKind &&
        r.documentLocalUuid === documentLocalUuid &&
        ['submitted', 'outcome_unknown'].includes(r.status)
    )
  }
  beginPreparing(jobUuid: string, leaseId: string): number {
    const r = this.rows.get(jobUuid)
    if (!r || r.status !== 'queued') return 0
    this.rows.set(jobUuid, { ...r, status: 'preparing', workerLeaseId: leaseId })
    return 1
  }
  recordLayout(jobUuid: string, leaseId: string, layoutJson: string, layoutSha256: string): number {
    const r = this.rows.get(jobUuid)
    if (!r || r.workerLeaseId !== leaseId || r.status !== 'preparing' || r.layoutJson !== null)
      return 0
    this.rows.set(jobUuid, { ...r, layoutJson, layoutSha256 })
    return 1
  }
  beginDispatching(jobUuid: string, leaseId: string, dispatchToken: string): number {
    const r = this.rows.get(jobUuid)
    if (!r || r.workerLeaseId !== leaseId || r.status !== 'preparing' || r.layoutJson === null)
      return 0
    this.rows.set(jobUuid, {
      ...r,
      status: 'dispatching',
      dispatchToken,
      dispatchedAt: '2026-01-01'
    })
    return 1
  }
  markSubmitted(jobUuid: string, dispatchToken: string): number {
    const r = this.rows.get(jobUuid)
    if (
      !r ||
      r.dispatchToken !== dispatchToken ||
      !['dispatching', 'outcome_unknown'].includes(r.status)
    )
      return 0
    this.rows.set(jobUuid, { ...r, status: 'submitted', finishedAt: '2026-01-01' })
    return 1
  }
  markOutcomeUnknownFromCallback(jobUuid: string, dispatchToken: string, reason: string): number {
    const r = this.rows.get(jobUuid)
    if (!r || r.dispatchToken !== dispatchToken || r.status !== 'dispatching') return 0
    this.rows.set(jobUuid, {
      ...r,
      status: 'outcome_unknown',
      failureCode: 'OS_REPORTED_FAILURE',
      osCallbackReason: reason,
      finishedAt: '2026-01-01'
    })
    return 1
  }
  markOutcomeUnknownFromTimeout(jobUuid: string, dispatchToken: string): number {
    const r = this.rows.get(jobUuid)
    if (!r || r.dispatchToken !== dispatchToken || r.status !== 'dispatching') return 0
    this.rows.set(jobUuid, { ...r, status: 'outcome_unknown', failureCode: 'CALLBACK_TIMEOUT' })
    return 1
  }
  markCancelledFromDialog(jobUuid: string, dispatchToken: string, reason: string): number {
    const r = this.rows.get(jobUuid)
    if (!r || r.dispatchToken !== dispatchToken || r.status !== 'dispatching') return 0
    this.rows.set(jobUuid, {
      ...r,
      status: 'cancelled',
      cancelOrigin: 'dialog',
      osCallbackReason: reason,
      finishedAt: '2026-01-01'
    })
    return 1
  }
  markFailedFromCallback(
    jobUuid: string,
    dispatchToken: string,
    code: string,
    reason: string
  ): number {
    const r = this.rows.get(jobUuid)
    if (!r || r.dispatchToken !== dispatchToken || r.status !== 'dispatching') return 0
    this.rows.set(jobUuid, {
      ...r,
      status: 'failed_before_dispatch',
      failureCode: code,
      osCallbackReason: reason,
      finishedAt: '2026-01-01'
    })
    return 1
  }
  markFailedFromSyncThrow(jobUuid: string, dispatchToken: string): number {
    const r = this.rows.get(jobUuid)
    if (!r || r.dispatchToken !== dispatchToken || r.status !== 'dispatching') return 0
    this.rows.set(jobUuid, {
      ...r,
      status: 'failed_before_dispatch',
      failureCode: 'PRINT_CALL_REJECTED',
      finishedAt: '2026-01-01'
    })
    return 1
  }
  markFailedBeforeDispatch(jobUuid: string, leaseId: string, code: string): number {
    const r = this.rows.get(jobUuid)
    if (!r || r.workerLeaseId !== leaseId || r.status !== 'preparing') return 0
    this.rows.set(jobUuid, {
      ...r,
      status: 'failed_before_dispatch',
      failureCode: code,
      finishedAt: '2026-01-01'
    })
    return 1
  }
  markCancelledFromQueue(jobUuid: string): number {
    const r = this.rows.get(jobUuid)
    if (!r || !['queued', 'preparing'].includes(r.status)) return 0
    this.rows.set(jobUuid, {
      ...r,
      status: 'cancelled',
      cancelOrigin: 'queue',
      finishedAt: '2026-01-01'
    })
    return 1
  }
  reconcileStartup(): { failedBeforeDispatch: number; outcomeUnknown: number } {
    return { failedBeforeDispatch: 0, outcomeUnknown: 0 }
  }
  recordWindowReleased(): number {
    return 1
  }
}

interface FakeRenderWindow {
  render: Mock
  capturePreviewPage: Mock
  verifyWithPdf: Mock
  dispatchPrint: Mock
}

interface FakeAccess {
  resolveCaller: Mock
  assertSaleDocument: Mock
  assertRefundDocument: Mock
}

interface FakeLocalSale {
  findInvoiceByLocalUuid: Mock
  itemsForInvoice: Mock
  paymentsForInvoice: Mock
}

function buildService(
  overrides: {
    jobs?: FakeJobRepository
    dispatchOutcome?:
      | { success: boolean; failureReason: string }
      | (() => Promise<{ success: boolean; failureReason: string }>)
    resolveCaller?: ReceiptOwner
    invoice?: LocalInvoiceRow
  } = {}
): {
  service: ReceiptPrintingService
  jobs: FakeJobRepository
  fakeRenderWindow: FakeRenderWindow
  access: FakeAccess
  invoice: LocalInvoiceRow
  localSale: FakeLocalSale
} {
  const jobs = overrides.jobs ?? new FakeJobRepository()
  const invoice = overrides.invoice ?? invoiceRow()

  const fakeRenderWindow: FakeRenderWindow = {
    render: vi.fn(async () => ({
      pageWidthUm: 80000,
      pageHeightUm: 100000,
      pageCount: 1,
      unusedLastPageUm: 0
    })),
    capturePreviewPage: vi.fn(async () => 'data:image/png;base64,AAA='),
    verifyWithPdf: vi.fn(async () => ({ pageCount: 1, matches: true, pdf: Buffer.from('x') })),
    dispatchPrint: vi.fn(async () => {
      const outcome = overrides.dispatchOutcome ?? { success: true, failureReason: '' }
      return typeof outcome === 'function' ? outcome() : outcome
    })
  }

  function fakeDoc(kind: 'sale' | 'refund' | 'test'): ReceiptDocument {
    return {
      kind,
      templateVersion: 1,
      locale: 'en',
      isReprint: false,
      header: {
        companyName: 'Fake Co',
        branchName: null,
        addressLines: [],
        phone: null,
        taxIdentifierLabel: null,
        taxIdentifierValue: null,
        logo: null
      },
      meta: {
        receiptNumberLabel: 'Receipt no.',
        receiptNumber: 'POS-1',
        serverNumberLabel: null,
        serverNumber: null,
        dateTimeText: '2026-01-01',
        cashierLabel: 'Cashier',
        cashierName: null,
        customerName: null,
        customerTaxNumber: null,
        currency: 'USD'
      },
      items: [],
      totals: {
        subtotalText: '$0.00',
        itemDiscountText: null,
        invoiceDiscountText: null,
        taxLines: [],
        grandTotalText: '$0.00',
        payments: [],
        paidText: null,
        changeText: null
      },
      refund: null,
      notices: [],
      footer: []
    }
  }

  const documents = {
    buildSaleDocument: vi.fn(() => fakeDoc('sale')),
    buildRefundDocument: vi.fn(() => fakeDoc('refund')),
    buildTestDocument: vi.fn(() => fakeDoc('test'))
  }

  const access: FakeAccess = {
    resolveCaller: vi.fn(() => overrides.resolveCaller ?? OWNER),
    assertSaleDocument: vi.fn((_owner: ReceiptOwner, row: LocalInvoiceRow | null) => {
      if (!row) throw new Error('not found')
      return row
    }),
    assertRefundDocument: vi.fn((_owner: ReceiptOwner, row: LocalRefundRow | null) => {
      if (!row) throw new Error('not found')
      return row
    })
  }

  const printerSettings = {
    get: vi.fn(() => ({
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
    }))
  }

  const localSale: FakeLocalSale = {
    findInvoiceByLocalUuid: vi.fn(() => invoice),
    itemsForInvoice: vi.fn(() => []),
    paymentsForInvoice: vi.fn(() => [])
  }
  const localRefunds = {
    findByLocalUuid: vi.fn(() => null),
    itemsForRefund: vi.fn(() => []),
    paymentsForRefund: vi.fn(() => [])
  }

  const service = new ReceiptPrintingService({
    jobs: jobs as unknown as ReceiptPrintJobRepository,
    access: access as unknown as ReceiptAccessService,
    documents: documents as unknown as ReceiptDocumentService,
    printerSettings: printerSettings as unknown as PrinterSettingsService,
    localSale: localSale as unknown as ReceiptPrintingDependencies['localSale'],
    localRefunds: localRefunds as unknown as ReceiptPrintingDependencies['localRefunds'],
    getPrinters: vi.fn(async () => [{ name: 'printer-1', displayName: 'Printer 1' }]),
    getRenderWindow: () => fakeRenderWindow as unknown as ReceiptRenderWindow,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    createUuid: (() => {
      let n = 0
      return () => `uuid-${++n}`
    })(),
    unknownTimeoutMs: 50
  })

  return { service, jobs, fakeRenderWindow, access, invoice, localSale }
}

async function previewAndDispatch(
  service: ReceiptPrintingService,
  requestId: string
): Promise<{ preview: PrintPreviewOutput; input: PrintingDispatchInput }> {
  const preview = await service.preview(OWNER, {
    document: { kind: 'sale', invoiceLocalUuid: 'inv-1' },
    locale: 'en',
    overrides: {}
  })
  const input: PrintingDispatchInput = {
    requestId,
    document: { kind: 'sale', invoiceLocalUuid: 'inv-1' },
    locale: 'en',
    overrides: {},
    preview: {
      previewDocumentSha256: preview.previewDocumentSha256,
      previewOptionsSha256: preview.previewOptionsSha256
    }
  }
  return { preview, input }
}

describe('ReceiptPrintingService.dispatch', () => {
  it('claims a job and reaches submitted on a successful OS callback', async () => {
    const { service } = buildService()
    const { input } = await previewAndDispatch(service, 'req-1')

    const result = await service.dispatch(OWNER, input)

    expect(result.status).toBe('submitted')
  })

  it('replays an exact retry read-only, without redispatching', async () => {
    const { service, fakeRenderWindow } = buildService()
    const { input } = await previewAndDispatch(service, 'req-2')

    const first = await service.dispatch(OWNER, input)
    const callsAfterFirst = fakeRenderWindow.dispatchPrint.mock.calls.length
    const second = await service.dispatch(OWNER, input)

    expect(second).toEqual(first)
    expect(fakeRenderWindow.dispatchPrint.mock.calls.length).toBe(callsAfterFirst) // no new dispatch
  })

  it('returns a conflict for the same requestId with a different intent, and does not dispatch', async () => {
    const { service, fakeRenderWindow } = buildService()
    const { input } = await previewAndDispatch(service, 'req-3')
    await service.dispatch(OWNER, input)
    const callsAfterFirst = fakeRenderWindow.dispatchPrint.mock.calls.length

    await expect(
      service.dispatch(OWNER, { ...input, overrides: { copies: 2 } })
    ).rejects.toMatchObject({
      backendCode: 'print_request_conflict'
    })
    expect(fakeRenderWindow.dispatchPrint.mock.calls.length).toBe(callsAfterFirst)
  })

  it('refuses a foreign owner requestId as not found, never leaking existence', async () => {
    const { service } = buildService()
    const { input } = await previewAndDispatch(service, 'req-4')
    await service.dispatch(OWNER, input)

    const otherOwner: ReceiptOwner = { ...OWNER, companyUuid: 'company-2' }
    await expect(service.dispatch(otherOwner, input)).rejects.toMatchObject({
      backendCode: 'receipt_not_found'
    })
  })

  it('rejects a stale preview (document changed since preview) with no dispatch', async () => {
    const { service, fakeRenderWindow, invoice } = buildService()
    const { input } = await previewAndDispatch(service, 'req-5')
    // Simulate a change between preview and dispatch by tampering with the stored preview hash.
    const tampered = {
      ...input,
      preview: { ...input.preview, previewDocumentSha256: 'x'.repeat(64) }
    }
    void invoice

    await expect(service.dispatch(OWNER, tampered)).rejects.toMatchObject({
      backendCode: 'receipt_preview_stale'
    })
    expect(fakeRenderWindow.dispatchPrint).not.toHaveBeenCalled()
  })

  it('two different requestIds for the same document: the second gets PRINT_DOCUMENT_BUSY only when truly concurrent', async () => {
    const { service, jobs } = buildService()
    const { input: inputA } = await previewAndDispatch(service, 'req-6a')
    // Manually claim a non-terminal row to simulate a genuinely in-flight job for req-6b's check.
    jobs.rows.set('manual-inflight', {
      jobUuid: 'manual-inflight',
      requestId: 'external-inflight',
      clientIntentJson: '{}',
      clientIntentSha256: 'y'.repeat(64),
      trigger: 'manual',
      ownerCompanyUuid: OWNER.companyUuid,
      ownerDeviceUuid: OWNER.deviceUuid,
      requestedByUserUuid: OWNER.userUuid,
      sessionEpochAtClaim: 1,
      documentKind: 'sale',
      documentLocalUuid: 'inv-1',
      documentJson: '{}',
      documentSha256: 'z'.repeat(64),
      templateVersion: 1,
      locale: 'en',
      isReprint: false,
      factsProjection: null,
      transactionFactsSha256: null,
      resolvedOptionsJson: '{}',
      optionsSha256: 'w'.repeat(64),
      layoutJson: null,
      layoutSha256: null,
      status: 'queued',
      cancelOrigin: null,
      workerLeaseId: null,
      dispatchToken: null,
      failureCode: null,
      osCallbackAt: null,
      osCallbackSuccess: null,
      osCallbackReason: null,
      createdAt: '2026-01-01',
      preparingAt: null,
      dispatchedAt: null,
      unknownAt: null,
      finishedAt: null,
      windowReleasedAt: null
    })

    await expect(service.dispatch(OWNER, inputA)).rejects.toMatchObject({
      backendCode: 'print_document_busy'
    })
  })

  it('classifies a definite pre-submission rejection as failed_before_dispatch, never outcome_unknown', async () => {
    const { service } = buildService({
      dispatchOutcome: { success: false, failureReason: 'Invalid printer settings' }
    })
    const { input } = await previewAndDispatch(service, 'req-7')

    const result = await service.dispatch(OWNER, input)

    expect(result.status).toBe('failed_before_dispatch')
    expect(result.failureCode).toBe('OS_REJECTED_SETTINGS')
  })

  it('classifies an unrecognized failure reason as outcome_unknown, never a silent failure', async () => {
    const { service } = buildService({
      dispatchOutcome: { success: false, failureReason: 'Print job failed' }
    })
    const { input } = await previewAndDispatch(service, 'req-8')

    const result = await service.dispatch(OWNER, input)

    expect(result.status).toBe('outcome_unknown')
  })

  it('a synchronous throw from print() is caught and mapped to failed_before_dispatch (T8)', async () => {
    const { service, fakeRenderWindow } = buildService()
    fakeRenderWindow.dispatchPrint = vi.fn(async () => {
      throw new Error('print() threw synchronously')
    })
    const { input } = await previewAndDispatch(service, 'req-9')

    const result = await service.dispatch(OWNER, input)

    expect(result.status).toBe('failed_before_dispatch')
    expect(result.failureCode).toBe('PRINT_CALL_REJECTED')
  })

  it('a callback timeout is classified as outcome_unknown', async () => {
    const { service } = buildService({
      dispatchOutcome: () => new Promise(() => {}) // never resolves -> hits the timeout race
    })
    const { input } = await previewAndDispatch(service, 'req-10')

    const result = await service.dispatch(OWNER, input)

    expect(result.status).toBe('outcome_unknown')
    expect(result.failureCode).toBe('CALLBACK_TIMEOUT')
  })

  it('the final gate refuses when the document no longer belongs to the caller (company switch)', async () => {
    const { service, access } = buildService()
    const { input } = await previewAndDispatch(service, 'req-11')
    access.resolveCaller = vi.fn(() => ({ ...OWNER, companyUuid: 'company-2' }))

    const result = await service.dispatch(OWNER, input)

    expect(result.status).toBe('failed_before_dispatch')
    expect(result.failureCode).toBe('SESSION_CHANGED')
  })

  it('the final gate refuses on a transaction-facts mismatch (tampered/corrupted facts)', async () => {
    const { service, localSale, invoice } = buildService()
    const { input } = await previewAndDispatch(service, 'req-12')

    // `findInvoiceByLocalUuid` is read twice during preview/claim (buildDocumentJson, buildFacts)
    // with the ORIGINAL invoice; starting from the 3rd read (the final gate's own document-state
    // and facts recheck), simulate the underlying row having changed -- e.g. a concurrent process
    // corrupting/tampering a protected amount between claim and the gate.
    let calls = 0
    localSale.findInvoiceByLocalUuid = vi.fn(() => {
      calls += 1
      return calls <= 2 ? invoice : { ...invoice, grandTotalAmount: 999999 }
    })

    const result = await service.dispatch(OWNER, input)

    expect(result.status).toBe('failed_before_dispatch')
    expect(result.failureCode).toBe('TRANSACTION_FACTS_MISMATCH')
  })

  it('marks the document as a reprint once a prior job has submitted', async () => {
    const { service } = buildService()
    const { input: firstInput } = await previewAndDispatch(service, 'req-13a')
    await service.dispatch(OWNER, firstInput)

    const { preview: secondPreview, input: secondInput } = await previewAndDispatch(
      service,
      'req-13b'
    )
    expect(secondPreview.isReprint).toBe(true)

    const result = await service.dispatch(OWNER, secondInput)
    expect(result.isReprint).toBe(true)
  })
})

describe('ReceiptPrintingService.cancelJob', () => {
  it('cancels a still-queued job with zero OS calls', async () => {
    const jobs = new FakeJobRepository()
    jobs.rows.set('job-x', {
      jobUuid: 'job-x',
      requestId: 'req-cancel',
      clientIntentJson: '{}',
      clientIntentSha256: 'a'.repeat(64),
      trigger: 'manual',
      ownerCompanyUuid: OWNER.companyUuid,
      ownerDeviceUuid: OWNER.deviceUuid,
      requestedByUserUuid: OWNER.userUuid,
      sessionEpochAtClaim: 1,
      documentKind: 'sale',
      documentLocalUuid: 'inv-1',
      documentJson: '{}',
      documentSha256: 'b'.repeat(64),
      templateVersion: 1,
      locale: 'en',
      isReprint: false,
      factsProjection: null,
      transactionFactsSha256: null,
      resolvedOptionsJson: '{}',
      optionsSha256: 'c'.repeat(64),
      layoutJson: null,
      layoutSha256: null,
      status: 'queued',
      cancelOrigin: null,
      workerLeaseId: null,
      dispatchToken: null,
      failureCode: null,
      osCallbackAt: null,
      osCallbackSuccess: null,
      osCallbackReason: null,
      createdAt: '2026-01-01',
      preparingAt: null,
      dispatchedAt: null,
      unknownAt: null,
      finishedAt: null,
      windowReleasedAt: null
    })
    const { service, fakeRenderWindow } = buildService({ jobs })

    const result = service.cancelJob(OWNER, 'req-cancel')

    expect(result.status).toBe('cancelled')
    expect(result.cancelOrigin).toBe('queue')
    expect(fakeRenderWindow.dispatchPrint).not.toHaveBeenCalled()
  })

  it('refuses to cancel a foreign-owner job as not found', async () => {
    const { service } = buildService()
    const { input } = await previewAndDispatch(service, 'req-cancel-2')
    await service.dispatch(OWNER, input)

    expect(() =>
      service.cancelJob({ ...OWNER, companyUuid: 'company-2' }, 'req-cancel-2')
    ).toThrow()
  })
})

describe('ReceiptPrintingService failure surfaces', () => {
  it('reports PRINTER_NONE_INSTALLED when no printers are installed', async () => {
    const { service, jobs } = buildService()
    ;(
      service as unknown as {
        dependencies: { getPrinters: ReceiptPrintingDependencies['getPrinters'] }
      }
    ).dependencies.getPrinters = vi.fn(async () => [])
    const { input } = await previewAndDispatch(service, 'req-14')

    const result = await service.dispatch(OWNER, input)

    expect(result.status).toBe('failed_before_dispatch')
    expect(result.failureCode).toBe('PRINTER_NONE_INSTALLED')
    expect(jobs.rows.get(result.jobUuid)?.dispatchToken).toBeNull()
  })

  it('reports PRINTER_NOT_FOUND for a printer name that is not in the discovered list', async () => {
    const { service } = buildService()
    const preview = await service.preview(OWNER, {
      document: { kind: 'sale', invoiceLocalUuid: 'inv-1' },
      locale: 'en',
      overrides: { printerName: 'nonexistent-printer' }
    })
    const input: PrintingDispatchInput = {
      requestId: 'req-15',
      document: { kind: 'sale', invoiceLocalUuid: 'inv-1' },
      locale: 'en',
      overrides: { printerName: 'nonexistent-printer' },
      preview: {
        previewDocumentSha256: preview.previewDocumentSha256,
        previewOptionsSha256: preview.previewOptionsSha256
      }
    }

    const result = await service.dispatch(OWNER, input)

    expect(result.status).toBe('failed_before_dispatch')
    expect(result.failureCode).toBe('PRINTER_NOT_FOUND')
  })
})
