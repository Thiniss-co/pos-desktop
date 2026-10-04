import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ApplicationServices } from '../app/applicationServices'
import type { ReceiptAccessService } from '../receipt/receiptAccess.service'
import type { PrinterSettingsService } from '../receipt/printerSettings.service'
import type { ReceiptPrintingService } from '../receipt/receiptPrinting.service'
import type { AutoPrintAdmissionService } from '../receipt/autoPrint.service'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown> | unknown
  >()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown> | unknown
      ) => {
        handlers.set(channel, handler)
      }
    )
  }
}))

const { assertTrustedSender } = vi.hoisted(() => ({ assertTrustedSender: vi.fn() }))
vi.mock('./assertTrustedSender', () => ({ assertTrustedSender }))

import { registerPrintingIpcHandlers } from './printing.ipc'

function fakeEvent(): IpcMainInvokeEvent {
  return {} as IpcMainInvokeEvent
}

const OWNER = {
  companyUuid: 'company-1',
  deviceUuid: 'device-1',
  userUuid: 'user-1',
  sessionEpoch: 1
}
const HASH = 'a'.repeat(64)

function buildServices(overrides: Partial<ApplicationServices> = {}): ApplicationServices {
  return {
    receiptAccess: {
      resolveCaller: vi.fn(() => OWNER)
    } as unknown as ReceiptAccessService,
    printerSettings: {
      get: vi.fn(),
      save: vi.fn((s: unknown) => s)
    } as unknown as PrinterSettingsService,
    receiptPrinting: {
      listPrinters: vi.fn(async () => []),
      preview: vi.fn(),
      dispatch: vi.fn(),
      getJob: vi.fn(),
      cancelJob: vi.fn(),
      latestForDocument: vi.fn()
    } as unknown as ReceiptPrintingService,
    autoPrint: {
      statusForSale: vi.fn(() => ({ state: 'pending', job: null })),
      setup: vi.fn(async () => ({ autoPrint: true, printerName: null, needsSetup: 'no_printer' })),
      noticesFor: vi.fn(() => []),
      dismissNotices: vi.fn()
    } as unknown as AutoPrintAdmissionService,
    ...overrides
  } as ApplicationServices
}

describe('printing IPC', () => {
  it('checks the sender before parsing the dispatch payload', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    const services = buildServices()
    handlers.clear()
    registerPrintingIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.printingDispatch)
    const result = await handler?.(fakeEvent(), { not: 'valid' })

    expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    expect(services.receiptPrinting.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a dispatch payload carrying raw html, a url, or an unknown key -- strict schema', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerPrintingIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.printingDispatch)
    const result = (await handler?.(fakeEvent(), {
      requestId: '00000000-0000-4000-8000-000000000001',
      document: { kind: 'sale', invoiceLocalUuid: '00000000-0000-4000-8000-000000000002' },
      locale: 'en',
      overrides: {},
      preview: { previewDocumentSha256: HASH, previewOptionsSha256: HASH },
      html: '<script>alert(1)</script>'
    })) as { ok: boolean; error?: { category: string } }

    expect(result.ok).toBe(false)
    expect(result.error?.category).toBe('validation')
    expect(services.receiptPrinting.dispatch).not.toHaveBeenCalled()
  })

  it('rejects an auto-sale requestId from the renderer -- not a valid uuid', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerPrintingIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.printingDispatch)
    const result = (await handler?.(fakeEvent(), {
      requestId: 'auto-sale:inv-1',
      document: { kind: 'sale', invoiceLocalUuid: '00000000-0000-4000-8000-000000000002' },
      locale: 'en',
      overrides: {},
      preview: { previewDocumentSha256: HASH, previewOptionsSha256: HASH }
    })) as { ok: boolean; error?: { category: string } }

    expect(result.ok).toBe(false)
    expect(result.error?.category).toBe('validation')
  })

  it('resolves the caller before returning workstation settings', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerPrintingIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.printingGetWorkstationSettings)
    await handler?.(fakeEvent(), undefined)

    expect(services.receiptAccess.resolveCaller).toHaveBeenCalled()
    expect(services.printerSettings.get).toHaveBeenCalled()
  })

  it('the happy path for dispatch forwards to ReceiptPrintingService with the resolved owner', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    ;(services.receiptPrinting.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobUuid: 'job-1',
      status: 'submitted',
      phase: null,
      failureCode: null,
      cancelOrigin: null,
      createdAt: '2026-01-01',
      dispatchedAt: '2026-01-01',
      finishedAt: '2026-01-01',
      isReprint: false
    })
    handlers.clear()
    registerPrintingIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.printingDispatch)
    const input = {
      requestId: '00000000-0000-4000-8000-000000000001',
      document: { kind: 'sale', invoiceLocalUuid: '00000000-0000-4000-8000-000000000002' },
      locale: 'en',
      overrides: {},
      preview: { previewDocumentSha256: HASH, previewOptionsSha256: HASH }
    }
    const result = (await handler?.(fakeEvent(), input)) as {
      ok: boolean
      data?: { status: string }
    }

    expect(result.ok).toBe(true)
    expect(result.data?.status).toBe('submitted')
    expect(services.receiptPrinting.dispatch).toHaveBeenCalledWith(OWNER, input)
  })

  it('rejects an admin-namespace-looking or filesystem-path-looking printer name at the schema layer if malformed', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerPrintingIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.printingSaveWorkstationSettings)
    const result = (await handler?.(fakeEvent(), {
      printerName: 'x'.repeat(400), // exceeds the 256-char bound
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
    })) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(services.printerSettings.save).not.toHaveBeenCalled()
  })
})

describe('POS improvements Stage 7: automatic-printing IPC', () => {
  const SALE = '00000000-0000-4000-8000-000000000002'

  it('reads one sale state for the resolved caller only', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerPrintingIpcHandlers(services)

    const result = await handlers.get(IPC_CHANNELS.printingAutoPrintStatus)?.(fakeEvent(), {
      invoiceLocalUuid: SALE
    })

    expect(result).toMatchObject({ ok: true, data: { state: 'pending', job: null } })
    expect(services.autoPrint.statusForSale).toHaveBeenCalledWith(OWNER, SALE)
  })

  it.each([
    ['a non-uuid sale', { invoiceLocalUuid: 'inv-1' }],
    ['an extra owner field', { invoiceLocalUuid: SALE, userUuid: 'user-2' }],
    ['no payload', undefined]
  ])('refuses %s before reading anything', async (_label, payload) => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerPrintingIpcHandlers(services)

    const result = (await handlers.get(IPC_CHANNELS.printingAutoPrintStatus)?.(
      fakeEvent(),
      payload
    )) as { ok: boolean; error?: { category: string } }

    expect(result.ok).toBe(false)
    expect(result.error?.category).toBe('validation')
    expect(services.autoPrint.statusForSale).not.toHaveBeenCalled()
  })

  it('refuses every automatic-printing channel from an untrusted sender', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    const services = buildServices()
    handlers.clear()
    registerPrintingIpcHandlers(services)

    for (const channel of [
      IPC_CHANNELS.printingAutoPrintStatus,
      IPC_CHANNELS.printingAutoPrintSetup,
      IPC_CHANNELS.printingAutoPrintNotices,
      IPC_CHANNELS.printingAutoPrintDismissNotices
    ]) {
      const result = await handlers.get(channel)?.(fakeEvent(), undefined)
      expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    }
    expect(services.autoPrint.setup).not.toHaveBeenCalled()
    expect(services.autoPrint.noticesFor).not.toHaveBeenCalled()
    expect(services.autoPrint.dismissNotices).not.toHaveBeenCalled()
  })

  it('setup, notices and dismiss require a signed-in caller with pos.view', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices({
      receiptAccess: {
        resolveCaller: vi.fn(() => {
          throw { category: 'authorization', message: 'no pos.view', retryable: false }
        })
      } as unknown as ReceiptAccessService
    })
    handlers.clear()
    registerPrintingIpcHandlers(services)

    for (const channel of [
      IPC_CHANNELS.printingAutoPrintSetup,
      IPC_CHANNELS.printingAutoPrintNotices,
      IPC_CHANNELS.printingAutoPrintDismissNotices
    ]) {
      const result = (await handlers.get(channel)?.(fakeEvent(), undefined)) as { ok: boolean }
      expect(result.ok).toBe(false)
    }
    expect(services.autoPrint.setup).not.toHaveBeenCalled()
    expect(services.autoPrint.dismissNotices).not.toHaveBeenCalled()
  })

  it('setup and notices take no arguments', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerPrintingIpcHandlers(services)

    const refused = (await handlers.get(IPC_CHANNELS.printingAutoPrintSetup)?.(fakeEvent(), {
      printerName: 'x'
    })) as { ok: boolean }
    const setup = await handlers.get(IPC_CHANNELS.printingAutoPrintSetup)?.(fakeEvent(), undefined)
    const notices = await handlers.get(IPC_CHANNELS.printingAutoPrintNotices)?.(
      fakeEvent(),
      undefined
    )

    expect(refused.ok).toBe(false)
    expect(setup).toMatchObject({ ok: true, data: { needsSetup: 'no_printer' } })
    expect(notices).toMatchObject({ ok: true, data: [] })
  })
})
