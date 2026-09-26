import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ApplicationServices } from '../app/applicationServices'
import type { ReceiptAccessService } from '../receipt/receiptAccess.service'
import type { ReceiptProfileAdminService } from '../receipt/receiptProfileAdmin.service'

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

import { registerReceiptProfileIpcHandlers } from './receiptProfile.ipc'

function fakeEvent(): IpcMainInvokeEvent {
  return {} as IpcMainInvokeEvent
}

const OWNER = {
  companyUuid: 'company-1',
  deviceUuid: 'device-1',
  userUuid: 'user-1',
  sessionEpoch: 1
}

function buildServices(overrides: Partial<ApplicationServices> = {}): ApplicationServices {
  return {
    receiptAccess: {
      resolveCaller: vi.fn(() => OWNER)
    } as unknown as ReceiptAccessService,
    receiptProfileAdmin: {
      get: vi.fn(() => ({
        capability: 'unsupported',
        canManage: false,
        profile: null,
        logo: null
      })),
      chooseLogo: vi.fn(),
      publish: vi.fn()
    } as unknown as ReceiptProfileAdminService,
    ...overrides
  } as ApplicationServices
}

const VALID_PUBLISH_INPUT = {
  expectedRevision: 0,
  fields: {
    addressLines: [],
    phone: null,
    taxIdentifierLabel: null,
    taxIdentifierValue: null,
    footerLines: []
  },
  logo: { action: 'keep' }
}

describe('receiptProfile IPC', () => {
  it('checks the sender before ever resolving the caller', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    const services = buildServices()
    handlers.clear()
    registerReceiptProfileIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.receiptProfileGet)
    const result = await handler?.(fakeEvent(), undefined)

    expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    expect(services.receiptAccess.resolveCaller).not.toHaveBeenCalled()
  })

  it('resolves the caller and forwards to ReceiptProfileAdminService.get', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerReceiptProfileIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.receiptProfileGet)
    const result = (await handler?.(fakeEvent(), undefined)) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(services.receiptAccess.resolveCaller).toHaveBeenCalled()
    expect(services.receiptProfileAdmin.get).toHaveBeenCalledWith(OWNER)
  })

  it('rejects a get/choose-logo call carrying any argument at all -- strict undefined schema', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerReceiptProfileIpcHandlers(services)

    const getHandler = handlers.get(IPC_CHANNELS.receiptProfileGet)
    const chooseLogoHandler = handlers.get(IPC_CHANNELS.receiptProfileChooseLogo)

    const getResult = (await getHandler?.(fakeEvent(), { anything: true })) as { ok: boolean }
    const chooseLogoResult = (await chooseLogoHandler?.(fakeEvent(), { path: '/etc/passwd' })) as {
      ok: boolean
    }

    expect(getResult.ok).toBe(false)
    expect(chooseLogoResult.ok).toBe(false)
    expect(services.receiptProfileAdmin.get).not.toHaveBeenCalled()
    expect(services.receiptProfileAdmin.chooseLogo).not.toHaveBeenCalled()
  })

  it('forwards choose-logo to ReceiptProfileAdminService with the resolved owner', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    ;(services.receiptProfileAdmin.chooseLogo as ReturnType<typeof vi.fn>).mockResolvedValue({
      sha256: 'a'.repeat(64),
      thumbnailPngDataUrl: 'data:image/png;base64,AAAA'
    })
    handlers.clear()
    registerReceiptProfileIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.receiptProfileChooseLogo)
    const result = (await handler?.(fakeEvent(), undefined)) as {
      ok: boolean
      data?: { sha256: string }
    }

    expect(result.ok).toBe(true)
    expect(result.data?.sha256).toBe('a'.repeat(64))
    expect(services.receiptProfileAdmin.chooseLogo).toHaveBeenCalledWith(OWNER)
  })

  it('rejects a publish payload with an unknown key or a raw path -- strict schema', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerReceiptProfileIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.receiptProfilePublish)
    const result = (await handler?.(fakeEvent(), {
      ...VALID_PUBLISH_INPUT,
      filePath: '/tmp/logo.png'
    })) as { ok: boolean; error?: { category: string } }

    expect(result.ok).toBe(false)
    expect(result.error?.category).toBe('validation')
    expect(services.receiptProfileAdmin.publish).not.toHaveBeenCalled()
  })

  it('rejects a "set" logo action naming an sha256 of the wrong shape', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerReceiptProfileIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.receiptProfilePublish)
    const result = (await handler?.(fakeEvent(), {
      ...VALID_PUBLISH_INPUT,
      logo: { action: 'set', sha256: 'not-a-sha' }
    })) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(services.receiptProfileAdmin.publish).not.toHaveBeenCalled()
  })

  it('the happy path for publish forwards to ReceiptProfileAdminService with the resolved owner', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    ;(services.receiptProfileAdmin.publish as ReturnType<typeof vi.fn>).mockResolvedValue({
      capability: 'supported',
      canManage: true,
      profile: null,
      logo: null
    })
    handlers.clear()
    registerReceiptProfileIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.receiptProfilePublish)
    const result = (await handler?.(fakeEvent(), VALID_PUBLISH_INPUT)) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(services.receiptProfileAdmin.publish).toHaveBeenCalledWith(OWNER, VALID_PUBLISH_INPUT)
  })
})
