import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { printBoundary as aliased } from '@printBoundary'
import { printBoundary, VIRTUAL_PRINTERS } from './printBoundary.virtual'

function fakeContents(): { contents: WebContents; print: ReturnType<typeof vi.fn> } {
  const print = vi.fn()
  const contents = {
    print,
    printToPDF: vi.fn(async () => Buffer.from('%PDF-1.4 fake')),
    getPrintersAsync: vi.fn(async () => [{ name: 'Real-OS-Printer', displayName: 'Real' }])
  } as unknown as WebContents
  return { contents, print }
}

const request = {
  silent: true,
  deviceName: 'PW-Virtual-80',
  copies: 1,
  pageWidthUm: 80_000,
  pageHeightUm: 120_000
}

describe('virtual print boundary (test builds only)', () => {
  let dir: string
  const previous = process.env.POS_VIRTUAL_PRINT_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pos-virtual-print-'))
    process.env.POS_VIRTUAL_PRINT_DIR = dir
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.POS_VIRTUAL_PRINT_DIR
    else process.env.POS_VIRTUAL_PRINT_DIR = previous
  })

  it('is what the @printBoundary alias resolves to under vitest', () => {
    expect(aliased.kind).toBe('virtual')
  })

  it('lists only virtual printers and never asks the OS', async () => {
    const { contents } = fakeContents()
    expect((await printBoundary.listPrinters(contents)).map((p) => p.name)).toEqual([
      ...VIRTUAL_PRINTERS
    ])
    expect(contents.getPrintersAsync).not.toHaveBeenCalled()
  })

  it('writes the job record synchronously and a PDF, and never calls webContents.print', async () => {
    const { contents, print } = fakeContents()
    const pending = printBoundary.dispatch(contents, request)
    // Recorded before any await: the dispatch is observable exactly at the boundary.
    expect(readFileSync(join(dir, 'dispatches.log'), 'utf8')).toContain('"PW-Virtual-80"')
    await expect(pending).resolves.toEqual({ success: true, failureReason: '' })
    expect(print).not.toHaveBeenCalled()
    expect(readdirSync(dir).some((f) => f.endsWith('.pdf'))).toBe(true)
  })

  it('honours the fail and hang modes', async () => {
    const { contents } = fakeContents()
    writeFileSync(join(dir, 'mode'), 'fail')
    await expect(printBoundary.dispatch(contents, request)).resolves.toEqual({
      success: false,
      failureReason: 'Print job failed'
    })
    writeFileSync(join(dir, 'mode'), 'hang')
    const outcome = await Promise.race([
      printBoundary.dispatch(contents, request).then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50))
    ])
    expect(outcome).toBe('pending')
  })

  it('refuses an unknown device and an unconfigured destination', async () => {
    const { contents, print } = fakeContents()
    await expect(
      printBoundary.dispatch(contents, { ...request, deviceName: 'Real-OS-Printer' })
    ).resolves.toEqual({ success: false, failureReason: 'Invalid deviceName provided' })
    delete process.env.POS_VIRTUAL_PRINT_DIR
    expect(await printBoundary.listPrinters(contents)).toEqual([])
    await expect(printBoundary.dispatch(contents, request)).resolves.toMatchObject({
      success: false
    })
    expect(print).not.toHaveBeenCalled()
  })

  it('refuses a real workstation profile as its destination', async () => {
    process.env.POS_VIRTUAL_PRINT_DIR = '/home/someone/.config/pos-desktop/printer'
    expect(await printBoundary.listPrinters(fakeContents().contents)).toEqual([])
  })
})
