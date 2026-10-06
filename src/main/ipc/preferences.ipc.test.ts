import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  preferencesGetLocaleInputSchema,
  preferencesSetLocaleInputSchema,
  preferencesGetThemeInputSchema,
  preferencesSetThemeInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import type { AppSettingsRepository } from '../repositories/appSettings.repository'
import { handleIpcRequest } from './handleIpcRequest'

// The cart-width block at the bottom registers the real handlers against a captured `ipcMain`
// (the checkout.ipc.test.ts pattern). The mocks are inert for the validator-level tests above it.
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

import { registerPreferencesIpcHandlers } from './preferences.ipc'

// See connectivity.ipc.test.ts for why this stays at the validator/handleIpcRequest layer instead
// of importing preferences.ipc.ts directly (it imports `electron`, which is not a real API outside
// a running Electron process).
describe('preferences IPC validation', () => {
  it('rejects any input for getLocale', async () => {
    const result = await handleIpcRequest(
      { locale: 'en' },
      preferencesGetLocaleInputSchema,
      () => 'not called'
    )

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
  })

  it('accepts only "en" or "ar" for setLocale, rejecting an arbitrary locale string', async () => {
    const accepted = await handleIpcRequest(
      'ar',
      preferencesSetLocaleInputSchema,
      (locale) => locale
    )
    expect(accepted).toEqual({ ok: true, data: 'ar' })

    const rejected = await handleIpcRequest(
      'fr',
      preferencesSetLocaleInputSchema,
      () => 'not called'
    )
    expect(rejected).toMatchObject({ ok: false, error: { category: 'validation' } })

    const rejectedInjection = await handleIpcRequest(
      "en'; DROP TABLE app_settings; --",
      preferencesSetLocaleInputSchema,
      () => 'not called'
    )
    expect(rejectedInjection).toMatchObject({ ok: false, error: { category: 'validation' } })
  })

  it('rejects any input for getTheme', async () => {
    const result = await handleIpcRequest(
      { theme: 'dark' },
      preferencesGetThemeInputSchema,
      () => 'not called'
    )

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
  })

  it('accepts only "light", "dark", or "system" for setTheme, rejecting arbitrary strings', async () => {
    for (const theme of ['light', 'dark', 'system'] as const) {
      const accepted = await handleIpcRequest(theme, preferencesSetThemeInputSchema, (t) => t)
      expect(accepted).toEqual({ ok: true, data: theme })
    }

    const rejected = await handleIpcRequest(
      'blue',
      preferencesSetThemeInputSchema,
      () => 'not called'
    )
    expect(rejected).toMatchObject({ ok: false, error: { category: 'validation' } })

    const rejectedInjection = await handleIpcRequest(
      "light'; DROP TABLE app_settings; --",
      preferencesSetThemeInputSchema,
      () => 'not called'
    )
    expect(rejectedInjection).toMatchObject({ ok: false, error: { category: 'validation' } })
  })
})

describe('preferences IPC — POS cart width (layout-only preference)', () => {
  const SETTING_KEY = 'ui.posCartWidth'
  let stored: Map<string, string>
  let settings: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }

  function fakeEvent(): IpcMainInvokeEvent {
    return {} as IpcMainInvokeEvent
  }

  function handler(
    channel: string
  ): (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown> | unknown {
    const registered = handlers.get(channel)
    expect(registered, `${channel} is registered`).toBeDefined()
    return registered as (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown> | unknown
  }

  beforeEach(() => {
    stored = new Map()
    settings = {
      get: vi.fn((key: string) => stored.get(key) ?? null),
      set: vi.fn((key: string, value: string) => {
        stored.set(key, value)
      })
    }
    assertTrustedSender.mockReset()
    assertTrustedSender.mockImplementation(() => undefined)
    handlers.clear()
    registerPreferencesIpcHandlers({
      appSettings: settings as unknown as AppSettingsRepository
    } as ApplicationServices)
  })

  it('persists an in-range integer width as a decimal string and echoes it back', async () => {
    const result = await handler(IPC_CHANNELS.preferencesSetPosCartWidth)(fakeEvent(), 448)

    expect(result).toEqual({ ok: true, data: 448 })
    expect(settings.set).toHaveBeenCalledWith(SETTING_KEY, '448')
    await expect(
      handler(IPC_CHANNELS.preferencesGetPosCartWidth)(fakeEvent(), undefined)
    ).resolves.toEqual({ ok: true, data: 448 })
  })

  it('stores null (the design default) as an empty string and reads it back as null', async () => {
    stored.set(SETTING_KEY, '512')

    const result = await handler(IPC_CHANNELS.preferencesSetPosCartWidth)(fakeEvent(), null)

    expect(result).toEqual({ ok: true, data: null })
    expect(settings.set).toHaveBeenCalledWith(SETTING_KEY, '')
    await expect(
      handler(IPC_CHANNELS.preferencesGetPosCartWidth)(fakeEvent(), undefined)
    ).resolves.toEqual({ ok: true, data: null })
  })

  it('accepts both boundaries of the stored range', async () => {
    for (const width of [320, 960]) {
      await expect(
        handler(IPC_CHANNELS.preferencesSetPosCartWidth)(fakeEvent(), width)
      ).resolves.toEqual({ ok: true, data: width })
    }
  })

  it('rejects an invalid set payload before it reaches the settings repository', async () => {
    const invalidPayloads: unknown[] = [
      319,
      961,
      400.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -400,
      '400',
      '',
      undefined,
      true,
      { width: 400 },
      [400],
      "400'; DROP TABLE app_settings; --"
    ]

    for (const payload of invalidPayloads) {
      const result = await handler(IPC_CHANNELS.preferencesSetPosCartWidth)(fakeEvent(), payload)
      expect(result, `payload ${String(payload)}`).toMatchObject({
        ok: false,
        error: { category: 'validation' }
      })
    }

    expect(settings.set).not.toHaveBeenCalled()
  })

  it('rejects any input on the get channel without reading the repository', async () => {
    for (const payload of [{}, null, 400, 'ui.posCartWidth']) {
      const result = await handler(IPC_CHANNELS.preferencesGetPosCartWidth)(fakeEvent(), payload)
      expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    }

    expect(settings.get).not.toHaveBeenCalled()
  })

  it('returns null when nothing has been stored', async () => {
    await expect(
      handler(IPC_CHANNELS.preferencesGetPosCartWidth)(fakeEvent(), undefined)
    ).resolves.toEqual({ ok: true, data: null })
    expect(settings.get).toHaveBeenCalledWith(SETTING_KEY)
  })

  it('degrades any stored garbage or out-of-range value to null instead of reaching the renderer', async () => {
    const garbage = [
      '',
      'abc',
      '100',
      '319',
      '961',
      '5000',
      '400.5',
      '0400',
      ' 400',
      '400 ',
      '4e2',
      '0x190',
      '-400',
      'null',
      '{"width":400}'
    ]

    for (const value of garbage) {
      stored.set(SETTING_KEY, value)
      await expect(
        handler(IPC_CHANNELS.preferencesGetPosCartWidth)(fakeEvent(), undefined),
        `stored ${JSON.stringify(value)}`
      ).resolves.toEqual({ ok: true, data: null })
    }

    stored.set(SETTING_KEY, '480')
    await expect(
      handler(IPC_CHANNELS.preferencesGetPosCartWidth)(fakeEvent(), undefined)
    ).resolves.toEqual({ ok: true, data: 480 })
  })

  it('checks the sender before parsing the payload or touching the repository', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })

    // A valid payload and an invalid one are both refused for the sender first, proving the order.
    for (const payload of [448, 'not a width']) {
      const result = await handler(IPC_CHANNELS.preferencesSetPosCartWidth)(fakeEvent(), payload)
      expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    }
    const readResult = await handler(IPC_CHANNELS.preferencesGetPosCartWidth)(
      fakeEvent(),
      undefined
    )
    expect(readResult).toMatchObject({ ok: false, error: { category: 'authorization' } })

    expect(assertTrustedSender).toHaveBeenCalledTimes(3)
    expect(settings.set).not.toHaveBeenCalled()
    expect(settings.get).not.toHaveBeenCalled()
  })

  it('maps a non-public guard failure to a sanitized unexpected error', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw new Error('/internal/path leaked')
    })

    const result = await handler(IPC_CHANNELS.preferencesSetPosCartWidth)(fakeEvent(), 448)

    expect(result).toEqual({
      ok: false,
      error: {
        category: 'unexpected',
        message: 'The request could not be completed',
        retryable: false
      }
    })
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('leaves the existing locale/theme handlers unguarded, exactly as before', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    stored.set('ui.theme', 'dark')
    stored.set('ui.locale', 'ar')

    await expect(
      handler(IPC_CHANNELS.preferencesGetTheme)(fakeEvent(), undefined)
    ).resolves.toEqual({ ok: true, data: 'dark' })
    await expect(
      handler(IPC_CHANNELS.preferencesGetLocale)(fakeEvent(), undefined)
    ).resolves.toEqual({ ok: true, data: 'ar' })
    expect(assertTrustedSender).not.toHaveBeenCalled()
  })
})

describe('POS improvements Stage 5: per-user preferences IPC', () => {
  function call(channel: string, input: unknown): Promise<unknown> {
    const registered = handlers.get(channel)
    if (!registered) {
      throw new Error(`no handler for ${channel}`)
    }
    return Promise.resolve(registered({ sender: {} } as IpcMainInvokeEvent, input))
  }

  let session: { isAuthenticated: boolean; companyUuid: string | null; userUuid: string | null }
  let rows: Map<string, boolean>

  beforeEach(async () => {
    const { UserPreferencesService } = await import('../services/userPreferences.service')
    session = { isAuthenticated: true, companyUuid: 'c-1', userUuid: 'u-1' }
    rows = new Map()
    const userPreferences = new UserPreferencesService({
      session: { getContext: () => session },
      repository: {
        get: (owner, key) => rows.get(`${owner.companyUuid}|${owner.userUuid}|${key}`) ?? null,
        set: (owner, key, value) => {
          rows.set(`${owner.companyUuid}|${owner.userUuid}|${key}`, value)
        }
      }
    })
    assertTrustedSender.mockReset()
    assertTrustedSender.mockImplementation(() => undefined)
    handlers.clear()
    registerPreferencesIpcHandlers({
      appSettings: { get: () => null, set: () => undefined } as unknown as AppSettingsRepository,
      userPreferences
    } as unknown as ApplicationServices)
  })

  it('defaults to touch off and automatic printing ON (D3) for a user who never chose', async () => {
    await expect(call(IPC_CHANNELS.preferencesGetUser, undefined)).resolves.toEqual({
      ok: true,
      data: { touchMode: false, autoPrint: true }
    })
  })

  it('stores each user separately and never takes an identity from the renderer', async () => {
    await call(IPC_CHANNELS.preferencesSetUser, { key: 'ui.touchMode', value: true })
    session = { isAuthenticated: true, companyUuid: 'c-1', userUuid: 'u-2' }

    await expect(call(IPC_CHANNELS.preferencesGetUser, undefined)).resolves.toEqual({
      ok: true,
      data: { touchMode: false, autoPrint: true }
    })
    await expect(
      call(IPC_CHANNELS.preferencesSetUser, {
        key: 'ui.touchMode',
        value: true,
        userUuid: 'u-1'
      })
    ).resolves.toMatchObject({ ok: false, error: { category: 'validation' } })
  })

  it('refuses an unknown key, a non-boolean value and a write before sign-in', async () => {
    await expect(
      call(IPC_CHANNELS.preferencesSetUser, { key: 'ui.theme', value: true })
    ).resolves.toMatchObject({ ok: false, error: { category: 'validation' } })
    await expect(
      call(IPC_CHANNELS.preferencesSetUser, { key: 'ui.touchMode', value: 'yes' })
    ).resolves.toMatchObject({ ok: false, error: { category: 'validation' } })
    session = { isAuthenticated: false, companyUuid: null, userUuid: null }
    await expect(
      call(IPC_CHANNELS.preferencesSetUser, { key: 'ui.touchMode', value: true })
    ).resolves.toMatchObject({ ok: false, error: { category: 'authentication' } })
    expect(rows.size).toBe(0)
  })

  it('refuses an untrusted sender before parsing the payload', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    await expect(
      call(IPC_CHANNELS.preferencesSetUser, { key: 'ui.touchMode', value: true })
    ).resolves.toMatchObject({ ok: false, error: { category: 'authorization' } })
    expect(rows.size).toBe(0)
  })
})

describe('POS workspace layout IPC', () => {
  type Session = {
    isAuthenticated: boolean
    companyUuid: string | null
    userUuid: string | null
    deviceUuid: string | null
    serverDeviceId: number | null
  }

  function call(channel: string, input: unknown): Promise<Record<string, unknown>> {
    const registered = handlers.get(channel)
    if (!registered) {
      throw new Error(`no handler for ${channel}`)
    }
    return Promise.resolve(registered({ sender: {} } as IpcMainInvokeEvent, input)) as Promise<
      Record<string, unknown>
    >
  }

  let session: Session
  let epoch: number
  let rows: Map<string, string>
  let defaults: typeof import('@shared/contracts/posWorkspace.contract')

  async function token(): Promise<string> {
    const read = (await call(IPC_CHANNELS.preferencesGetPosWorkspace, undefined)) as {
      data: { contextToken: string }
    }
    return read.data.contextToken
  }

  beforeEach(async () => {
    const { WorkspaceLayoutService } = await import('../services/workspaceLayout.service')
    defaults = await import('@shared/contracts/posWorkspace.contract')
    session = {
      isAuthenticated: true,
      companyUuid: 'c-1',
      userUuid: 'u-1',
      deviceUuid: 'd-1',
      serverDeviceId: 7
    }
    epoch = 1
    rows = new Map()
    const key = (o: { companyUuid: string; userUuid: string; deviceUuid: string }): string =>
      `${o.companyUuid}|${o.userUuid}|${o.deviceUuid}`
    const workspaceLayout = new WorkspaceLayoutService({
      session: { getContext: () => session },
      epoch: { current: () => epoch },
      repository: {
        get: (owner) => rows.get(key(owner)) ?? null,
        set: (owner, json) => {
          rows.set(key(owner), json)
        },
        delete: (owner) => {
          rows.delete(key(owner))
        }
      }
    })
    assertTrustedSender.mockReset()
    assertTrustedSender.mockImplementation(() => undefined)
    handlers.clear()
    registerPreferencesIpcHandlers({
      appSettings: { get: () => null, set: () => undefined } as unknown as AppSettingsRepository,
      workspaceLayout
    } as unknown as ApplicationServices)
  })

  it('returns the Cart-first default with a context token for a signed-in user', async () => {
    const result = await call(IPC_CHANNELS.preferencesGetPosWorkspace, undefined)
    expect(result).toMatchObject({
      ok: true,
      data: { layout: defaults.defaultWorkspaceLayout(), stored: false }
    })
    expect(typeof (result.data as { contextToken: unknown }).contextToken).toBe('string')
  })

  it('stores per company, user AND device, with the owner taken from the session only', async () => {
    const balanced = defaults.clonePreset('balanced')
    await expect(
      call(IPC_CHANNELS.preferencesSetPosWorkspace, {
        layout: balanced,
        contextToken: await token()
      })
    ).resolves.toMatchObject({ ok: true, data: { layout: balanced, stored: true } })

    for (const other of [
      { userUuid: 'u-2' },
      { companyUuid: 'c-2' },
      { deviceUuid: 'd-2' }
    ] as Partial<Session>[]) {
      const previous = session
      session = { ...session, ...other }
      await expect(call(IPC_CHANNELS.preferencesGetPosWorkspace, undefined)).resolves.toMatchObject(
        {
          ok: true,
          data: { layout: defaults.defaultWorkspaceLayout(), stored: false }
        }
      )
      session = previous
    }

    await expect(
      call(IPC_CHANNELS.preferencesSetPosWorkspace, {
        layout: balanced,
        contextToken: await token(),
        userUuid: 'u-9'
      })
    ).resolves.toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(rows.size).toBe(1)
  })

  it('refuses a write whose context token no longer matches (user switch, refresh, new epoch)', async () => {
    const scanner = defaults.clonePreset('scanner')
    const first = await token()
    session = { ...session, userUuid: 'u-2' }
    await expect(
      call(IPC_CHANNELS.preferencesSetPosWorkspace, { layout: scanner, contextToken: first })
    ).resolves.toMatchObject({ ok: false, error: { category: 'conflict' } })

    session = { ...session, userUuid: 'u-1', serverDeviceId: 8 }
    await expect(
      call(IPC_CHANNELS.preferencesSetPosWorkspace, { layout: scanner, contextToken: first })
    ).resolves.toMatchObject({ ok: false, error: { category: 'conflict' } })

    session = { ...session, serverDeviceId: 7 }
    epoch = 2
    await expect(
      call(IPC_CHANNELS.preferencesSetPosWorkspace, { layout: scanner, contextToken: first })
    ).resolves.toMatchObject({ ok: false, error: { category: 'conflict' } })
    expect(rows.size).toBe(0)
  })

  it('removes the row on restore defaults (null)', async () => {
    await call(IPC_CHANNELS.preferencesSetPosWorkspace, {
      layout: defaults.clonePreset('balanced'),
      contextToken: await token()
    })
    await expect(
      call(IPC_CHANNELS.preferencesSetPosWorkspace, { layout: null, contextToken: await token() })
    ).resolves.toMatchObject({
      ok: true,
      data: { layout: defaults.defaultWorkspaceLayout(), stored: false }
    })
    expect(rows.size).toBe(0)
  })

  it('validates the layout: ids, bounds, order, extra keys and size', async () => {
    const base = defaults.defaultWorkspaceLayout()
    const contextToken = await token()
    for (const layout of [
      { ...base, cartShare: 99 },
      { ...base, sections: { ...base.sections, cart: ['totals', 'scan', 'lines', 'actions'] } },
      { ...base, cart: [{ sku: 'WS-01', quantity: '1.000' }] },
      { ...base, preset: 'x'.repeat(4000) }
    ]) {
      await expect(
        call(IPC_CHANNELS.preferencesSetPosWorkspace, { layout, contextToken })
      ).resolves.toMatchObject({ ok: false, error: { category: 'validation' } })
    }
    expect(rows.size).toBe(0)
  })

  it('salvages a corrupted stored row instead of failing the read', async () => {
    rows.set('c-1|u-1|d-1', '{"version":1,"density":"comfortable","cartShare":"wide"}')
    await expect(call(IPC_CHANNELS.preferencesGetPosWorkspace, undefined)).resolves.toMatchObject({
      ok: true,
      data: {
        layout: { ...defaults.defaultWorkspaceLayout(), density: 'comfortable' },
        stored: true
      }
    })
  })

  it('reads defaults signed out and refuses writes; refuses an untrusted sender first', async () => {
    const contextToken = await token()
    session = { ...session, isAuthenticated: false }
    await expect(call(IPC_CHANNELS.preferencesGetPosWorkspace, undefined)).resolves.toMatchObject({
      ok: true,
      data: { stored: false, contextToken: null }
    })
    await expect(
      call(IPC_CHANNELS.preferencesSetPosWorkspace, {
        layout: defaults.defaultWorkspaceLayout(),
        contextToken
      })
    ).resolves.toMatchObject({ ok: false, error: { category: 'authentication' } })

    session = { ...session, isAuthenticated: true, deviceUuid: null }
    await expect(
      call(IPC_CHANNELS.preferencesSetPosWorkspace, {
        layout: defaults.defaultWorkspaceLayout(),
        contextToken
      })
    ).resolves.toMatchObject({ ok: false, error: { category: 'authentication' } })

    session = { ...session, deviceUuid: 'd-1' }
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    await expect(
      call(IPC_CHANNELS.preferencesSetPosWorkspace, { layout: null, contextToken })
    ).resolves.toMatchObject({ ok: false, error: { category: 'authorization' } })
    await expect(call(IPC_CHANNELS.preferencesGetPosWorkspace, undefined)).resolves.toMatchObject({
      ok: false,
      error: { category: 'authorization' }
    })
    expect(rows.size).toBe(0)
  })
})
