import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import type {
  PrintBoundary,
  PrintBoundaryDispatch,
  PrintBoundaryResult
} from './printBoundary.types'

/**
 * The controlled, test-only print destination (never present in a production bundle; see
 * printBoundary.types.ts). It never calls `webContents.print`, so no job can reach an OS spooler.
 *
 * Configuration is read per call from the environment so one launched app can switch modes:
 *  - `POS_VIRTUAL_PRINT_DIR`: absolute directory receiving `job-<n>.pdf` + `job-<n>.json` per dispatch.
 *    Without it the destination lists no printers and refuses every dispatch.
 *  - `<dir>/mode` (optional file): `ok` (default) | `fail` | `hang` -- the outcome of the NEXT dispatch.
 *  - `<dir>/printers` (optional file): newline-separated printer names (default: the two below).
 *  - `<dir>/hold-auto-admission` (optional file): while it exists, automatic-print admission waits.
 *  - `<dir>/qr-capture-delay-ms` (optional file): milliseconds to hold preparation before the
 *    rendered QR is captured.
 */
export const VIRTUAL_PRINTERS = ['PW-Virtual-80', 'PW-Virtual-58'] as const

function destination(): string | null {
  const dir = process.env.POS_VIRTUAL_PRINT_DIR
  if (!dir || !isAbsolute(dir) || dir.includes('/.config/pos-desktop')) {
    return null
  }
  const resolved = resolve(dir)
  mkdirSync(resolved, { recursive: true })
  return resolved
}

function readOptional(dir: string, file: string): string | null {
  const path = join(dir, file)
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null
}

function printerNames(dir: string): string[] {
  const configured = readOptional(dir, 'printers')
  if (configured === null) {
    return [...VIRTUAL_PRINTERS]
  }
  return configured
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

let sequence = 0

export const printBoundary: PrintBoundary = {
  kind: 'virtual',

  async listPrinters() {
    const dir = destination()
    if (!dir) {
      return []
    }
    return printerNames(dir).map((name) => ({ name, displayName: name }))
  },

  holdsAutoAdmission() {
    const dir = destination()
    return dir !== null && existsSync(join(dir, 'hold-auto-admission'))
  },

  async beforeQrCapture() {
    const dir = destination()
    const delay = dir === null ? 0 : Number(readOptional(dir, 'qr-capture-delay-ms') ?? 0)
    if (Number.isFinite(delay) && delay > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(delay, 120_000)))
    }
  },

  dispatch(contents: WebContents, request: PrintBoundaryDispatch): Promise<PrintBoundaryResult> {
    const dir = destination()
    if (!dir) {
      return Promise.resolve({
        success: false,
        failureReason: 'virtual destination not configured'
      })
    }
    sequence += 1
    const id = `job-${Date.now()}-${sequence}`
    const mode = readOptional(dir, 'mode') ?? 'ok'
    const record = {
      id,
      dispatchedAt: new Date().toISOString(),
      mode,
      silent: request.silent,
      deviceName: request.deviceName,
      copies: request.copies,
      pageWidthUm: request.pageWidthUm,
      pageHeightUm: request.pageHeightUm
    }
    // The dispatch is recorded synchronously, before any asynchronous work, so the call itself is
    // observable exactly at the boundary (the fence-then-dispatch tests rely on this).
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(record, null, 2))
    appendFileSync(join(dir, 'dispatches.log'), `${JSON.stringify(record)}\n`)

    if (request.deviceName !== null && !printerNames(dir).includes(request.deviceName)) {
      return Promise.resolve({ success: false, failureReason: 'Invalid deviceName provided' })
    }
    if (mode === 'hang') {
      return new Promise<PrintBoundaryResult>(() => undefined)
    }

    return contents
      .printToPDF({
        landscape: false,
        printBackground: true,
        pageSize: { width: request.pageWidthUm / 25_400, height: request.pageHeightUm / 25_400 },
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      })
      .then((pdf) => {
        writeFileSync(join(dir, `${id}.pdf`), pdf)
        return mode === 'fail'
          ? { success: false, failureReason: 'Print job failed' }
          : { success: true, failureReason: '' }
      })
  }
}
