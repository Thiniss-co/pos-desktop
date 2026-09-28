import { describe, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'
import { PrintingService } from './service'

/**
 * Regression: callers keep the receipt document and overrides in Vue refs, which are reactive
 * Proxies. Electron's preload bridge cannot clone a Proxy ("An object could not be cloned"), which
 * made every UI-opened receipt preview fail. The service must hand the gateway plain data.
 */
describe('PrintingService IPC payloads', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a local mock bag
  function gateway() {
    const ok = { ok: true as const, data: null }
    return {
      getWorkstationSettings: vi.fn(),
      saveWorkstationSettings: vi.fn<(settings: unknown) => Promise<typeof ok>>(async () => ok),
      listPrinters: vi.fn(),
      preview: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
        ok: true as const,
        data: { pages: [] }
      })),
      dispatch: vi.fn<(input: unknown) => Promise<typeof ok>>(async () => ok),
      getJob: vi.fn(),
      cancelJob: vi.fn(),
      latestForDocument: vi.fn<(input: unknown) => Promise<typeof ok>>(async () => ok)
    }
  }

  function isProxyFree(value: unknown): boolean {
    // A plain copy has no Vue reactivity markers and structured-clones cleanly.
    try {
      structuredClone(value)
    } catch {
      return false
    }
    return !(value && typeof value === 'object' && '__v_raw' in (value as object))
  }

  it('sends plain copies of reactive preview, dispatch and latest-job payloads', async () => {
    const bridge = gateway()
    const service = new PrintingService(bridge as unknown as Window['posApi']['printing'])
    const document = ref({ kind: 'refund' as const, refundLocalUuid: 'r-1' })
    const overrides = reactive({ copies: 2, printerName: undefined as string | undefined })

    await service.preview({ document: document.value, locale: 'en', overrides })
    await service.dispatch({
      document: document.value,
      locale: 'ar',
      overrides,
      previewDocumentSha256: 'a'.repeat(64),
      previewOptionsSha256: 'b'.repeat(64)
    } as never)
    await service.latestForDocument(document.value)

    const previewArg = bridge.preview.mock.calls[0][0]
    expect(isProxyFree(previewArg)).toBe(true)
    expect(previewArg).toEqual({
      document: { kind: 'refund', refundLocalUuid: 'r-1' },
      locale: 'en',
      overrides: { copies: 2 }
    })
    expect(isProxyFree(bridge.dispatch.mock.calls[0][0])).toBe(true)
    expect(isProxyFree(bridge.latestForDocument.mock.calls[0][0])).toBe(true)
    expect(bridge.latestForDocument.mock.calls[0][0]).toEqual({
      document: { kind: 'refund', refundLocalUuid: 'r-1' }
    })
  })

  it('sends a plain copy of reactive workstation settings', async () => {
    const bridge = gateway()
    const service = new PrintingService(bridge as unknown as Window['posApi']['printing'])
    const settings = reactive({ paperWidthMm: 80, copies: 1 })

    await service.saveWorkstationSettings(settings as never)

    expect(isProxyFree(bridge.saveWorkstationSettings.mock.calls[0][0])).toBe(true)
  })
})
