import type { WebContents } from 'electron'
import type {
  PrintBoundary,
  PrintBoundaryDispatch,
  PrintBoundaryResult
} from './printBoundary.types'

/** The real OS spooler boundary. Only production builds resolve `@printBoundary` to this module. */
export const printBoundary: PrintBoundary = {
  kind: 'os',

  async listPrinters(contents: WebContents) {
    const printers = await contents.getPrintersAsync()
    return printers.map((printer) => ({ name: printer.name, displayName: printer.displayName }))
  },

  dispatch(contents: WebContents, request: PrintBoundaryDispatch): Promise<PrintBoundaryResult> {
    return new Promise((resolve, reject) => {
      try {
        contents.print(
          {
            silent: request.silent,
            deviceName: request.deviceName ?? undefined,
            copies: request.copies,
            printBackground: true,
            scaleFactor: 100,
            margins: { marginType: 'none' },
            pageSize: { width: request.pageWidthUm, height: request.pageHeightUm }
          },
          (success, failureReason) => resolve({ success, failureReason })
        )
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
