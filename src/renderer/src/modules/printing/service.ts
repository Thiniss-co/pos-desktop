import type {
  PrinterInfo,
  PrinterSettings,
  PrintingDispatchInput,
  PrintingPreviewInput,
  PrintJobView,
  PrintPreviewOutput,
  ReceiptDocumentRef
} from '@shared/contracts/printing.contract'
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
    return unwrapIpcResult(await this.gateway.saveWorkstationSettings(settings))
  }

  async listPrinters(): Promise<PrinterInfo[]> {
    return unwrapIpcResult(await this.gateway.listPrinters())
  }

  async preview(input: PrintingPreviewInput): Promise<PrintPreviewOutput> {
    return unwrapIpcResult(await this.gateway.preview(input))
  }

  async dispatch(input: PrintingDispatchInput): Promise<PrintJobView> {
    return unwrapIpcResult(await this.gateway.dispatch(input))
  }

  async getJob(requestId: string): Promise<PrintJobView> {
    return unwrapIpcResult(await this.gateway.getJob({ requestId }))
  }

  async cancelJob(requestId: string): Promise<PrintJobView> {
    return unwrapIpcResult(await this.gateway.cancelJob({ requestId }))
  }

  async latestForDocument(document: ReceiptDocumentRef): Promise<PrintJobView | null> {
    return unwrapIpcResult(await this.gateway.latestForDocument({ document }))
  }
}
