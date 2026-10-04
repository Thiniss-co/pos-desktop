import { BrowserWindow, session } from 'electron'
import { pxToUm, roundUpToQuantum } from '@shared/receipt/receiptLayout'
import { printBoundary } from '@printBoundary'

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

  /**
   * POS improvements, Stage 6 — the rendered receipt QR as an RGBA bitmap, for the pre-dispatch decode.
   *
   * The QR is printed at ~0.4–0.5 mm per module, about 2 px at 96 dpi: too small to decode reliably. So
   * the hidden window is zoomed (`scale`), the `#receipt-qr` element scrolled into view and only its
   * box captured; zoom and size are then restored. Print and PDF output use page sizes, not the window
   * zoom, and the layout plan was already measured and recorded before this runs.
   */
  async captureQrBitmap(
    scale = 4
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
    // Test builds only: lets a journey hold preparation open (undefined in the production boundary).
    await printBoundary.beforeQrCapture?.()
    const contents = this.window.webContents
    const [baseWidth, baseHeight] = this.window.getContentSize()
    const frame = (): Promise<unknown> =>
      contents.executeJavaScript(
        'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
      )
    try {
      contents.setZoomFactor(scale)
      this.window.setContentSize(
        Math.ceil((baseWidth ?? 280) * scale) + 16,
        Math.min(Math.ceil((baseHeight ?? 400) * scale) + 16, 2400)
      )
      await frame()
      const rect = (await contents.executeJavaScript(
        `(() => {
          const block = document.getElementById('receipt-qr')
          const svg = block ? block.querySelector('svg') : null
          if (!svg) return null
          svg.scrollIntoView({ block: 'center', inline: 'center' })
          const box = svg.getBoundingClientRect()
          return { x: box.x, y: box.y, width: box.width, height: box.height }
        })()`
      )) as { x: number; y: number; width: number; height: number } | null
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return null
      }
      await frame()
      const settled = (await contents.executeJavaScript(
        `(() => { const svg = document.querySelector('#receipt-qr svg'); if (!svg) return null; const b = svg.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } })()`
      )) as { x: number; y: number; width: number; height: number } | null
      const box = settled ?? rect
      const image = await contents.capturePage({
        x: Math.max(0, Math.floor(box.x * scale)),
        y: Math.max(0, Math.floor(box.y * scale)),
        width: Math.ceil(box.width * scale),
        height: Math.ceil(box.height * scale)
      })
      const { width, height } = image.getSize()
      const bgra = image.toBitmap()
      if (width === 0 || height === 0 || bgra.length < width * height * 4) {
        return null
      }
      const data = new Uint8ClampedArray(width * height * 4)
      for (let index = 0; index < width * height * 4; index += 4) {
        data[index] = bgra[index + 2] ?? 0
        data[index + 1] = bgra[index + 1] ?? 0
        data[index + 2] = bgra[index] ?? 0
        data[index + 3] = 255
      }
      return { data, width, height }
    } finally {
      contents.setZoomFactor(1)
      this.window.setContentSize(baseWidth ?? 280, baseHeight ?? 400)
      await frame().catch(() => undefined)
    }
  }

  /** Plan §D-6/electron-security.md "Safe Printing Bridge": only `name`/`displayName` (and a
   *  coarse status when the OS exposes one) ever cross the IPC boundary -- never `options` or any
   *  device URI/handle. */
  async listPrinters(): Promise<Array<{ name: string; displayName: string }>> {
    return printBoundary.listPrinters(this.window.webContents)
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

  /**
   * The OS print call, through the build-selected boundary. The boundary invokes the destination
   * synchronously, so a caller's synchronous authorization fence directly precedes the dispatch.
   */
  dispatchPrint(
    options: PrintDispatchOptions
  ): Promise<{ success: boolean; failureReason: string }> {
    const plan = this.requirePlan()
    return printBoundary.dispatch(this.window.webContents, {
      silent: options.silent,
      deviceName: options.deviceName ?? null,
      copies: options.copies,
      pageWidthUm: Math.max(353, plan.pageWidthUm),
      pageHeightUm: Math.max(353, plan.pageHeightUm)
    })
  }

  /** Which print boundary this build contains: 'os' in production, 'virtual' in test builds. */
  printBoundaryKind(): 'os' | 'virtual' {
    return printBoundary.kind
  }

  getPlan(): PagePlan {
    return this.requirePlan()
  }

  /** The hidden window's contents id (never an app window: it holds no catalog draft). */
  contentsId(): number | null {
    return this.window.isDestroyed() ? null : this.window.webContents.id
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

/** Test builds only: whether automatic-print admission is held (always false in production). */
export function autoPrintAdmissionHeld(): boolean {
  return printBoundary.holdsAutoAdmission?.() ?? false
}

/**
 * POS improvements, Stage 7: the contents id of the shared render window, if it exists. The catalog
 * install gate must never wait for this window: automatic printing can create it (to list printers)
 * before it has rendered anything, when its URL is still empty rather than `data:`.
 */
export function sharedReceiptRenderContentsId(): number | null {
  return sharedWindow?.contentsId() ?? null
}

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
