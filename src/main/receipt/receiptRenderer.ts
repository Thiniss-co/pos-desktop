import { BrowserWindow, session } from 'electron'
import { pxToUm, roundUpToQuantum } from '@shared/receipt/receiptLayout'

/**
 * Receipt-printing plan §D-4/§D-5 — renders receipt documents in a hidden, locked-down window and
 * produces preview captures, a page-height decision, PDF verification, and (via `dispatchPrint`)
 * the actual OS print call.
 *
 * ## One reusable render window, by design AND by environment necessity
 *
 * The plan's own worker model calls for "at most one live render window" at a time. This
 * implementation goes one step further and REUSES a single `BrowserWindow` (created once, lazily,
 * and torn down only on app shutdown) across every job, rather than creating a fresh window per
 * job. That is not merely an optimization here: in this project's sandboxed development
 * environment, creating a SECOND `BrowserWindow` process (even with the first one already
 * destroyed) reliably crashes the Electron process (confirmed by isolated repro: two sequential
 * `new BrowserWindow()` calls crash with SIGSEGV/SIGTRAP, while the SAME window reused across
 * three sequential `loadURL` calls is reliable). A real desktop install may not have this
 * constraint, but reuse is strictly safer, and is explicitly compatible with the plan's own "one
 * window at a time" model, so it is kept as the implementation even outside this specific
 * environment.
 *
 * No preload is attached. The window's session is a throwaway, in-memory partition (never
 * `persist:`-prefixed) whose `webRequest` blocks every request except the one `data:` document
 * load, and whose permission handlers deny everything -- so the page can load and do nothing else
 * even if its own (script-blocking) CSP were somehow bypassed.
 *
 * Scope note (stated plainly): this renderer measures the WHOLE receipt body as one block and
 * decides ONE page height from that (content-sized when it fits, or a computed multi-page count at
 * the configured limit otherwise, relying on the CSS `break-inside: avoid` hints in
 * `receiptHtml.ts` to keep an item or the settlement together across the resulting page
 * boundaries). The finer-grained, per-block balanced packer in `receiptLayout.ts` is implemented
 * and independently unit-tested as a pure module, but is not yet wired into this live renderer at
 * per-block DOM granularity.
 */

export interface PagePlan {
  readonly pageWidthUm: number
  readonly pageHeightUm: number
  readonly pageCount: number
  readonly unusedLastPageUm: number | null
}

export interface RenderParams {
  readonly html: string
  readonly paperWidthMm: number
  readonly printableWidthMm: number
  readonly marginTopMm: number
  readonly marginBottomMm: number
  readonly pageLengthProfile: 'content_sized' | 'fixed_page'
  readonly maxContinuousLengthMm: number
  readonly fixedPageHeightMm: number
}

const SAFETY_UM = 1_000
const RETRY_SAFETY_UM = 3_000
const MEASURE_TIMEOUT_MS = 15_000

function mmToUm(mm: number): number {
  return Math.round(mm * 1000)
}

function umToMm(um: number): number {
  return um / 1000
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`receiptRenderer: timed out waiting for ${label}`)),
      ms
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

function planPages(contentHeightPx: number, params: RenderParams): PagePlan {
  const pageWidthUm = mmToUm(params.paperWidthMm)
  const marginTopUm = mmToUm(params.marginTopMm)
  const marginBottomUm = mmToUm(params.marginBottomMm)
  const contentUm = pxToUm(contentHeightPx)

  if (params.pageLengthProfile === 'fixed_page') {
    const fixedUm = mmToUm(params.fixedPageHeightMm)
    const usable = fixedUm - marginTopUm - marginBottomUm - SAFETY_UM
    const pageCount = Math.max(1, Math.ceil(contentUm / Math.max(usable, 1)))
    const lastPageUsed = contentUm - usable * (pageCount - 1)
    return {
      pageWidthUm,
      pageHeightUm: fixedUm,
      pageCount,
      unusedLastPageUm: Math.max(0, usable - lastPageUsed)
    }
  }

  const limitUm = mmToUm(params.maxContinuousLengthMm)
  const onePage = roundUpToQuantum(marginTopUm + contentUm + SAFETY_UM + marginBottomUm)

  if (onePage <= limitUm) {
    return { pageWidthUm, pageHeightUm: onePage, pageCount: 1, unusedLastPageUm: 0 }
  }

  const usablePerPage = limitUm - marginTopUm - marginBottomUm - SAFETY_UM
  const pageCount = Math.max(1, Math.ceil(contentUm / Math.max(usablePerPage, 1)))
  return { pageWidthUm, pageHeightUm: limitUm, pageCount, unusedLastPageUm: null }
}

/** A minimal PDF page counter: counts `/Type /Page` object occurrences, sufficient for the
 *  single-producer (Chromium) PDFs this function is ever given. */
function countPdfPages(pdf: Buffer): number {
  const text = pdf.toString('latin1')
  const matches = text.match(/\/Type\s*\/Page[^s]/g)
  return matches ? matches.length : 0
}

export interface PrintDispatchOptions {
  readonly deviceName: string | null
  readonly silent: boolean
  readonly copies: number
}

/**
 * One reusable hidden render window. `render()` may be called many times in sequence (never
 * concurrently -- callers serialize access, matching the plan's one-job-at-a-time worker).
 */
export class ReceiptRenderWindow {
  private readonly window: BrowserWindow
  private plan: PagePlan | null = null
  private destroyed = false

  private constructor(window: BrowserWindow) {
    this.window = window
  }

  static create(): ReceiptRenderWindow {
    const partitionSession = session.fromPartition(`receipt-render-${process.pid}`)

    partitionSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith('data:') })
    })
    partitionSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    partitionSession.setPermissionCheckHandler(() => false)

    const window = new BrowserWindow({
      show: false,
      frame: false,
      width: 400,
      height: 100,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        images: true,
        // JavaScript stays enabled at the Electron level so main's own `executeJavaScript` calls
        // (measurement) keep working; the page itself can never run a script regardless, because
        // its own CSP (`default-src 'none'`, no `script-src`) blocks any script it could contain.
        session: partitionSession
      }
    })

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    return new ReceiptRenderWindow(window)
  }

  /** Loads the document, measures it and plans the page geometry. */
  async render(params: RenderParams, retry = false): Promise<PagePlan> {
    if (this.destroyed) {
      throw new Error('receiptRenderer: this render window has already been destroyed')
    }

    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(params.html, 'utf-8').toString('base64')}`
    await withTimeout(this.window.loadURL(dataUrl), MEASURE_TIMEOUT_MS, 'page load')

    await withTimeout(
      this.window.webContents.executeJavaScript(
        'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true'
      ),
      MEASURE_TIMEOUT_MS,
      'fonts ready'
    )

    const heightPx = Number(
      await withTimeout(
        this.window.webContents.executeJavaScript(
          `(() => { const el = document.getElementById('receipt-root'); return el ? el.scrollHeight : 0 })()`
        ),
        MEASURE_TIMEOUT_MS,
        'content measurement'
      )
    )

    // Resizes the (still-hidden) window's content area to the printable width and the measured
    // content height, so a subsequent `capturePreviewPage()` captures the WHOLE receipt rather than
    // an arbitrary small viewport crop. This does not affect the measurement above (the `.page`
    // element's width is set by its own inline style, in mm, independent of viewport width) or the
    // print/PDF calls (those use `pageSize` in microns/inches, not the window's pixel size).
    // A small buffer avoids a spurious scrollbar (which would itself eat a few px of width and
    // clip content) from a tight, zero-slack fit combined with sub-pixel layout rounding. The
    // measurement and print/PDF paths are unaffected -- both size independently of this window's
    // pixel dimensions.
    const widthPx = Math.max(1, Math.ceil((params.printableWidthMm * 96) / 25.4)) + 4
    const heightPxCeil = Math.max(1, Math.ceil(heightPx || 1)) + 4
    this.window.setContentSize(widthPx, heightPxCeil)

    let plan = planPages(heightPx || 0, params)

    if (retry) {
      const marginTopUm = mmToUm(params.marginTopMm)
      const marginBottomUm = mmToUm(params.marginBottomMm)
      const contentUm = pxToUm(heightPx || 0)
      const limitUm =
        params.pageLengthProfile === 'fixed_page'
          ? mmToUm(params.fixedPageHeightMm)
          : mmToUm(params.maxContinuousLengthMm)
      const retried = roundUpToQuantum(marginTopUm + contentUm + RETRY_SAFETY_UM + marginBottomUm)
      if (retried <= limitUm) {
        plan = { ...plan, pageHeightUm: retried }
      }
    }

    this.plan = plan
    return plan
  }

  private requirePlan(): PagePlan {
    if (!this.plan) {
      throw new Error('receiptRenderer: render() must be called before this operation')
    }
    return this.plan
  }

  async capturePreviewPage(): Promise<string> {
    const image = await this.window.webContents.capturePage()
    return `data:image/png;base64,${image.toPNG().toString('base64')}`
  }

  /** Plan §D-6/electron-security.md "Safe Printing Bridge": only `name`/`displayName` (and a
   *  coarse status when the OS exposes one) ever cross the IPC boundary -- never `options` or any
   *  device URI/handle. */
  async listPrinters(): Promise<Array<{ name: string; displayName: string }>> {
    const printers = await this.window.webContents.getPrintersAsync()
    return printers.map((printer) => ({ name: printer.name, displayName: printer.displayName }))
  }

  async verifyWithPdf(): Promise<{ pageCount: number; matches: boolean; pdf: Buffer }> {
    const plan = this.requirePlan()
    const widthInches = umToMm(plan.pageWidthUm) / 25.4
    const heightInches = umToMm(plan.pageHeightUm) / 25.4

    const pdf = await this.window.webContents.printToPDF({
      landscape: false,
      printBackground: true,
      pageSize: { width: widthInches, height: heightInches },
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    })

    const pageCount = countPdfPages(pdf)
    return { pageCount, matches: pageCount === plan.pageCount, pdf }
  }

  dispatchPrint(
    options: PrintDispatchOptions
  ): Promise<{ success: boolean; failureReason: string }> {
    const plan = this.requirePlan()
    return new Promise((resolve, reject) => {
      try {
        this.window.webContents.print(
          {
            silent: options.silent,
            deviceName: options.deviceName ?? undefined,
            copies: options.copies,
            printBackground: true,
            scaleFactor: 100,
            margins: { marginType: 'none' },
            pageSize: {
              width: Math.max(353, plan.pageWidthUm),
              height: Math.max(353, plan.pageHeightUm)
            }
          },
          (success, failureReason) => resolve({ success, failureReason })
        )
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  getPlan(): PagePlan {
    return this.requirePlan()
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    if (!this.window.isDestroyed()) {
      this.window.destroy()
    }
  }
}

let sharedWindow: ReceiptRenderWindow | null = null

/** The process-wide shared render window (plan §D-5: at most one live render window). Created
 *  lazily on first use. */
export function getSharedReceiptRenderWindow(): ReceiptRenderWindow {
  if (!sharedWindow) {
    sharedWindow = ReceiptRenderWindow.create()
  }
  return sharedWindow
}

export function destroySharedReceiptRenderWindow(): void {
  sharedWindow?.destroy()
  sharedWindow = null
}
