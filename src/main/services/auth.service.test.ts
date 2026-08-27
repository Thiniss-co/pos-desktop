import { describe, expect, it, vi } from 'vitest'
import { DesktopApiClient } from '../http/desktopApiClient'
import type {
  SessionContext,
  SessionEstablishInput
} from '../repositories/sessionMetadata.repository'
import { AuthService, DESKTOP_ACCESS_TOKEN_KEY } from './auth.service'
import type { StoredDeviceIdentity } from './deviceIdentity.service'

const identity: StoredDeviceIdentity = {
  deviceUuid: '00000000-0000-4000-8000-000000000002',
  deviceName: 'Front Register',
  platform: 'linux',
  osVersion: '6.0',
  appVersion: '1.0.0',
  isRegistered: true
}

function loginSuccessEnvelope(): Record<string, unknown> {
  return {
    success: true,
    message: 'Desktop login successful.',
    code: 'DESKTOP_LOGIN_SUCCESS',
    data: {
      token: 'plaintext-desktop-token-should-never-leak',
      token_type: 'Bearer',
      abilities: ['desktop'],
      user: {
        id: 1,
        uuid: '11111111-1111-4111-8111-111111111111',
        name: 'Cashier One',
        email: 'cashier@example.test',
        is_active: true,
        roles: ['cashier'],
        permissions: ['pos.sell']
      },
      device: {
        id: 'server-device-uuid',
        device_uuid: identity.deviceUuid,
        device_name: identity.deviceName,
        platform: identity.platform
      },
      access: {
        allowed: true,
        is_active: true,
        is_trial: false,
        is_in_grace: false,
        is_expired: false,
        is_suspended: false,
        can_login: true,
        can_sell: true,
        can_sync: true,
        can_activate_device: true,
        restriction_level: 'none'
      }
    },
    meta: {}
  }
}

function userContextSuccessEnvelope(): Record<string, unknown> {
  return {
    success: true,
    message: 'Desktop user context retrieved successfully.',
    code: 'DESKTOP_USER_CONTEXT_RETRIEVED',
    data: {
      user: {
        id: 1,
        uuid: '11111111-1111-4111-8111-111111111111',
        name: 'Cashier One',
        email: 'cashier@example.test',
        is_active: true,
        roles: ['cashier'],
        permissions: ['pos.view']
      },
      device: {
        id: 'server-device-uuid',
        device_uuid: identity.deviceUuid,
        device_name: identity.deviceName,
        platform: identity.platform
      },
      company: {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Example Company',
        is_active: true
      },
      branch: null,
      warehouse: null,
      access: {
        allowed: true,
        is_active: true,
        is_trial: false,
        is_in_grace: false,
        is_expired: false,
        is_suspended: false,
        can_login: true,
        can_sell: true,
        can_sync: true,
        can_activate_device: true,
        restriction_level: 'none'
      }
    },
    meta: {}
  }
}

interface FakeSecureStorage {
  encryptionAvailable: boolean
  getStatus: () => { encryptionAvailable: boolean }
  getSecret: (key: string) => string | null
  setSecret: (key: string, value: string) => void
  deleteSecret: (key: string) => void
  secrets: Map<string, string>
}

function createFakeSecureStorage(): FakeSecureStorage {
  const secrets = new Map<string, string>()
  return {
    encryptionAvailable: true,
    getStatus: () => ({ encryptionAvailable: true }),
    getSecret: (key: string) => secrets.get(key) ?? null,
    setSecret: (key: string, value: string) => {
      secrets.set(key, value)
    },
    deleteSecret: (key: string) => {
      secrets.delete(key)
    },
    secrets
  }
}

interface FakeSessionMetadata {
  getSummary: () => { isAuthenticated: boolean; userName: string | null; userEmail: string | null }
  getContext: () => SessionContext
  establish: (input: SessionEstablishInput) => void
  clear: () => void
}

function createFakeSessionMetadata(): FakeSessionMetadata {
  let userName: string | null = null
  let userEmail: string | null = null
  let context: SessionContext = {
    isAuthenticated: false,
    userUuid: null,
    userIsActive: false,
    companyUuid: null,
    deviceUuid: null,
    serverDeviceId: null
  }

  return {
    getSummary: () => ({
      isAuthenticated: Boolean(userEmail),
      userName,
      userEmail
    }),
    getContext: () => context,
    establish: (input) => {
      userName = input.userName
      userEmail = input.userEmail
      context = {
        isAuthenticated: Boolean(input.userEmail && input.userUuid),
        userUuid: input.userUuid ?? null,
        userIsActive: input.userIsActive === true,
        companyUuid: input.companyUuid ?? null,
        deviceUuid: input.deviceUuid ?? null,
        serverDeviceId: input.serverDeviceId ?? null
      }
    },
    clear: () => {
      userName = null
      userEmail = null
      context = {
        isAuthenticated: false,
        userUuid: null,
        userIsActive: false,
        companyUuid: null,
        deviceUuid: null,
        serverDeviceId: null
      }
    }
  }
}

describe('AuthService.login', () => {
  it('injects the main-owned device context and never returns the token to callers', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => null,
      getDeviceUuid: () => null,
      fetchImplementation: (async (_url: unknown, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined
        return { ok: true, status: 200, json: async () => loginSuccessEnvelope() } as Response
      }) as unknown as typeof fetch
    })

    const secureStorage = createFakeSecureStorage()
    const sessionMetadata = createFakeSessionMetadata()
    const service = new AuthService(
      apiClient,
      { get: () => identity },
      sessionMetadata,
      secureStorage
    )

    const summary = await service.login({ email: 'cashier@example.test', password: 'hunter2' })

    expect(capturedBody?.device_uuid).toBe(identity.deviceUuid)
    expect(capturedBody?.email).toBe('cashier@example.test')
    expect(capturedBody?.password).toBe('hunter2')
    expect(summary).toEqual({
      isAuthenticated: true,
      userName: 'Cashier One',
      userEmail: 'cashier@example.test'
    })
    expect(JSON.stringify(summary)).not.toContain('plaintext-desktop-token-should-never-leak')
    expect(secureStorage.secrets.get(DESKTOP_ACCESS_TOKEN_KEY)).toBe(
      'plaintext-desktop-token-should-never-leak'
    )
  })

  it('starts a fresh main-owned session after successful login', async () => {
    const sessionMetadata = createFakeSessionMetadata()
    const startSession = vi.fn((input: SessionEstablishInput) => sessionMetadata.establish(input))
    const service = new AuthService(
      {
        request: async () => loginSuccessEnvelope().data
      } as unknown as DesktopApiClient,
      { get: () => identity },
      sessionMetadata,
      createFakeSecureStorage(),
      {
        endSession: () => undefined,
        getSummary: () => sessionMetadata.getSummary(),
        refreshSession: (input) => sessionMetadata.establish(input),
        startSession
      }
    )

    await service.login({ email: 'cashier@example.test', password: 'hunter2' })

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userUuid: '11111111-1111-4111-8111-111111111111',
        companyUuid: null,
        deviceUuid: identity.deviceUuid
      })
    )
  })

  it('rejects login before device activation has completed', async () => {
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => null,
      getDeviceUuid: () => null,
      fetchImplementation: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({})
      })) as unknown as typeof fetch
    })

    const service = new AuthService(
      apiClient,
      { get: () => null },
      createFakeSessionMetadata(),
      createFakeSecureStorage()
    )

    await expect(service.login({ email: 'a@b.test', password: 'x' })).rejects.toMatchObject({
      category: 'configuration'
    })
  })

  it('deletes the freshly-stored token if session metadata persistence fails (compensation)', async () => {
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => null,
      getDeviceUuid: () => null,
      fetchImplementation: (async () => ({
        ok: true,
        status: 200,
        json: async () => loginSuccessEnvelope()
      })) as unknown as typeof fetch
    })

    const secureStorage = createFakeSecureStorage()
    const service = new AuthService(
      apiClient,
      { get: () => identity },
      {
        getSummary: () => ({ isAuthenticated: false, userName: null, userEmail: null }),
        getContext: () => ({
          isAuthenticated: false,
          userUuid: null,
          userIsActive: false,
          companyUuid: null,
          deviceUuid: null,
          serverDeviceId: null
        }),
        establish: () => {
          throw new Error('disk full')
        },
        clear: () => undefined
      },
      secureStorage
    )

    await expect(
      service.login({ email: 'cashier@example.test', password: 'hunter2' })
    ).rejects.toThrow('disk full')

    expect(secureStorage.secrets.has(DESKTOP_ACCESS_TOKEN_KEY)).toBe(false)
  })
})

describe('AuthService.refreshSession', () => {
  it('does not start a new session epoch for a routine refresh', async () => {
    const sessionMetadata = createFakeSessionMetadata()
    sessionMetadata.establish({
      userName: 'Cashier One',
      userEmail: 'cashier@example.test',
      userUuid: '11111111-1111-4111-8111-111111111111',
      userIsActive: true,
      companyUuid: '22222222-2222-4222-8222-222222222222',
      deviceUuid: identity.deviceUuid,
      serverDeviceId: 'server-device-uuid'
    })
    const startSession = vi.fn()
    const secureStorage = createFakeSecureStorage()
    secureStorage.setSecret(DESKTOP_ACCESS_TOKEN_KEY, 'stored-token')
    const service = new AuthService(
      {
        request: async () => userContextSuccessEnvelope().data
      } as unknown as DesktopApiClient,
      { get: () => identity },
      sessionMetadata,
      secureStorage,
      {
        endSession: () => undefined,
        getSummary: () => sessionMetadata.getSummary(),
        refreshSession: (input) => sessionMetadata.establish(input),
        startSession
      }
    )

    await service.refreshSession()

    expect(startSession).not.toHaveBeenCalled()
  })

  it('clears the local session when the stored token is missing or corrupt', async () => {
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => null,
      getDeviceUuid: () => identity.deviceUuid,
      fetchImplementation: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({})
      })) as unknown as typeof fetch
    })

    let cleared = false
    const service = new AuthService(
      apiClient,
      { get: () => identity },
      {
        getSummary: () => ({
          isAuthenticated: true,
          userName: 'Cashier One',
          userEmail: 'c@e.test'
        }),
        getContext: () => ({
          isAuthenticated: true,
          userUuid: '11111111-1111-4111-8111-111111111111',
          userIsActive: true,
          companyUuid: '22222222-2222-4222-8222-222222222222',
          deviceUuid: identity.deviceUuid,
          serverDeviceId: 'server-device-uuid'
        }),
        establish: () => undefined,
        clear: () => {
          cleared = true
        }
      },
      {
        getStatus: () => ({ encryptionAvailable: true }),
        getSecret: () => null,
        setSecret: () => undefined,
        deleteSecret: () => undefined
      }
    )

    await service.refreshSession()
    expect(cleared).toBe(true)
  })

  it('preserves the session and surfaces a device transition when the token is device-mismatched', async () => {
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'stored-token',
      getDeviceUuid: () => identity.deviceUuid,
      fetchImplementation: (async () => ({
        ok: false,
        status: 403,
        json: async () => ({
          success: false,
          message: 'Desktop token is not valid for this device.',
          code: 'DESKTOP_TOKEN_DEVICE_MISMATCH',
          errors: {},
          meta: {}
        })
      })) as unknown as typeof fetch
    })

    let deletedSecret = false
    let cleared = false
    const service = new AuthService(
      apiClient,
      { get: () => identity },
      {
        getSummary: () => ({
          isAuthenticated: true,
          userName: 'Cashier One',
          userEmail: 'c@e.test'
        }),
        getContext: () => ({
          isAuthenticated: true,
          userUuid: '11111111-1111-4111-8111-111111111111',
          userIsActive: true,
          companyUuid: '22222222-2222-4222-8222-222222222222',
          deviceUuid: identity.deviceUuid,
          serverDeviceId: 'server-device-uuid'
        }),
        establish: () => undefined,
        clear: () => {
          cleared = true
        }
      },
      {
        getStatus: () => ({ encryptionAvailable: true }),
        getSecret: () => 'stored-token',
        setSecret: () => undefined,
        deleteSecret: () => {
          deletedSecret = true
        }
      }
    )

    await expect(service.refreshSession()).rejects.toMatchObject({
      backendCode: 'DESKTOP_TOKEN_DEVICE_MISMATCH'
    })
    expect(deletedSecret).toBe(false)
    expect(cleared).toBe(false)
  })

  it('hydrates a legacy display-only session before catalog access', async () => {
    let context: SessionContext = {
      isAuthenticated: false,
      userUuid: null,
      userIsActive: false,
      companyUuid: null,
      deviceUuid: null,
      serverDeviceId: null
    }
    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => 'stored-token',
      getDeviceUuid: () => identity.deviceUuid,
      fetchImplementation: (async () => ({
        ok: true,
        status: 200,
        json: async () => userContextSuccessEnvelope()
      })) as unknown as typeof fetch
    })
    const service = new AuthService(
      apiClient,
      { get: () => identity },
      {
        getSummary: () => ({
          isAuthenticated: true,
          userName: 'Cashier One',
          userEmail: 'cashier@example.test'
        }),
        getContext: () => context,
        establish: (input) => {
          context = {
            isAuthenticated: Boolean(input.userEmail && input.userUuid),
            userUuid: input.userUuid ?? null,
            userIsActive: input.userIsActive === true,
            companyUuid: input.companyUuid ?? null,
            deviceUuid: input.deviceUuid ?? null,
            serverDeviceId: input.serverDeviceId ?? null
          }
        },
        clear: () => undefined
      },
      {
        getStatus: () => ({ encryptionAvailable: true }),
        getSecret: () => 'stored-token',
        setSecret: () => undefined,
        deleteSecret: () => undefined
      }
    )

    await service.ensureCatalogReadContext()

    expect(context).toEqual({
      isAuthenticated: true,
      userUuid: '11111111-1111-4111-8111-111111111111',
      userIsActive: true,
      companyUuid: '22222222-2222-4222-8222-222222222222',
      deviceUuid: identity.deviceUuid,
      serverDeviceId: 'server-device-uuid'
    })
  })
})
