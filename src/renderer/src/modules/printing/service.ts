import type {
  AutoPrintNotice,
  AutoPrintSetup,
  AutoPrintStatus,
  PrinterInfo,
  PrinterSettings,
  PrintingDispatchInput,
  PrintingPreviewInput,
  PrintJobView,
  PrintPreviewOutput,
  ReceiptDocumentRef
} from '@shared/contracts/printing.contract'
import { toIpcPayload } from '@renderer/shared/utils/ipcPayload'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

/**
 * Receipt-printing plan -- the renderer-side printing service. Every call is a narrow intent
 * (a document reference, locale, output overrides, or a requestId); main alone builds the receipt
 * content, renders it, and talks to the OS printer. This class never touches `fetch`/`axios` and
 * never receives raw HTML back -- only pre-rendered preview images.
 */
export class PrintingService {
  constructor(private readonly gateway: Window['posApi']['printing'] = window.posApi.printing) {}

  async getWorkstationSettings(): Promise<PrinterSettings> {
    return unwrapIpcResult(await this.gateway.getWorkstationSettings())
  }

  async saveWorkstationSettings(settings: PrinterSettings): Promise<PrinterSettings> {
    return unwrapIpcResult(await this.gateway.saveWorkstationSettings(toIpcPayload(settings)))
  }

  async listPrinters(): Promise<PrinterInfo[]> {
    return unwrapIpcResult(await this.gateway.listPrinters())
  }

  async preview(input: PrintingPreviewInput): Promise<PrintPreviewOutput> {
    return unwrapIpcResult(await this.gateway.preview(toIpcPayload(input)))
  }

  async dispatch(input: PrintingDispatchInput): Promise<PrintJobView> {
    return unwrapIpcResult(await this.gateway.dispatch(toIpcPayload(input)))
  }

  async getJob(requestId: string): Promise<PrintJobView> {
    return unwrapIpcResult(await this.gateway.getJob({ requestId }))
  }

  async cancelJob(requestId: string): Promise<PrintJobView> {
    return unwrapIpcResult(await this.gateway.cancelJob({ requestId }))
  }

  async latestForDocument(document: ReceiptDocumentRef): Promise<PrintJobView | null> {
    return unwrapIpcResult(await this.gateway.latestForDocument(toIpcPayload({ document })))
  }

  /** POS improvements, Stage 7: the automatic-print state of one sale (the complete panel's chip). */
  async autoPrintStatus(invoiceLocalUuid: string): Promise<AutoPrintStatus> {
    return unwrapIpcResult(await this.gateway.autoPrintStatus({ invoiceLocalUuid }))
  }

  async autoPrintSetup(): Promise<AutoPrintSetup> {
    return unwrapIpcResult(await this.gateway.autoPrintSetup())
  }

  async autoPrintNotices(): Promise<AutoPrintNotice[]> {
    return unwrapIpcResult(await this.gateway.autoPrintNotices())
  }

  async dismissAutoPrintNotices(): Promise<void> {
    unwrapIpcResult(await this.gateway.dismissAutoPrintNotices())
  }
}
