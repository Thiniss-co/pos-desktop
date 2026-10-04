import type { WebContents } from 'electron'

/**
 * The final OS print boundary: the only place a receipt can leave the process for a printer.
 *
 * Which implementation a build contains is decided at BUILD time through the `@printBoundary` module
 * alias (electron.vite.config.ts, vitest.config.ts and the esbuild runners), never at runtime:
 *  - `printBoundary.os.ts` (the default, every production build): the real Chromium spooler call;
 *  - `printBoundary.virtual.ts` (the Playwright harness build, vitest and the Electron-node test
 *    bundles): a controlled destination that writes PDFs into a run directory and can never reach
 *    `webContents.print`.
 * A production bundle therefore contains no virtual destination, and a test bundle contains no OS
 * print call; `scripts/verifyPrintBoundary.mjs` checks both properties on built output.
 */
export interface PrintBoundaryPrinter {
  readonly name: string
  readonly displayName: string
}

export interface PrintBoundaryDispatch {
  readonly silent: boolean
  readonly deviceName: string | null
  readonly copies: number
  /** Page size in microns, exactly as handed to `webContents.print`. */
  readonly pageWidthUm: number
  readonly pageHeightUm: number
}

export interface PrintBoundaryResult {
  readonly success: boolean
  readonly failureReason: string
}

export interface PrintBoundary {
  readonly kind: 'os' | 'virtual'
  listPrinters(contents: WebContents): Promise<PrintBoundaryPrinter[]>
  /**
   * Must invoke the destination synchronously (before returning the promise) so the caller's
   * authorization fence and this call are not separated by an asynchronous step.
   */
  dispatch(contents: WebContents, request: PrintBoundaryDispatch): Promise<PrintBoundaryResult>
  /**
   * POS improvements, Stage 7 — fault-injection seams, present ONLY in the virtual destination (the
   * production boundary leaves both undefined, so production behaviour cannot be changed by them):
   *  - `holdsAutoAdmission`: true while automatic-print admission must not run (to stop the app
   *    between a sale's commit and its admission);
   *  - `beforeQrCapture`: awaited before the rendered QR is captured (to hold preparation open).
   */
  holdsAutoAdmission?(): boolean
  beforeQrCapture?(): Promise<void>
}
