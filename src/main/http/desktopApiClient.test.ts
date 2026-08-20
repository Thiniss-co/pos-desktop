import { describe, expect, it, vi } from 'vitest'
import type { ApiTracer } from './apiTrace'
import { DesktopApiClient, resolveDesktopApiUrl } from './desktopApiClient'

describe('resolveDesktopApiUrl', () => {
  const apiOrigin = new URL('https://api.example.test')

  it('keeps requests inside the desktop namespace', () => {
    expect(resolveDesktopApiUrl(apiOrigin, '/bootstrap').toString()).toBe(
      'https://api.example.test/api/v1/desktop/bootstrap'
    )
  })

  it.each(['/api/v1/admin/users', '/api/v1/auth/login', 'https://example.test', '/../bootstrap'])(
    'rejects forbidden path %s',
    (path) => {
      expect(() => resolveDesktopApiUrl(apiOrigin, path)).toThrow(
        'Only relative desktop API paths are allowed'
      )
    }
  )
})

describe('DesktopApiClient diagnostics', () => {
  const deviceRegisterRoute = {
    path: '/device/register',
    method: 'POST' as const,
    requiresAuth: false,
    requiresDeviceUuid: false
  }

  function createClient(
    overrides: Partial<ConstructorParameters<typeof DesktopApiClient>[0]> = {}
  ): DesktopApiClient {
    return new DesktopApiClient({
      apiOrigin: new URL('https://api.example.test'),
      getAccessToken: () => null,
      getDeviceUuid: () => null,
      ...overrides
    })
  }

  it('throws a typed configuration error when no backend origin is configured', async () => {
    const client = createClient({ apiOrigin: null })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'configuration',
      retryable: false
    })
  })

  it('normalizes connection-refused fetch failures', async () => {
    const client = createClient({
      fetchImplementation: vi.fn(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8000')
      })
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'transport',
      message: 'The desktop service refused the connection'
    })
  })

  it('emits one start and one terminal trace event without credentials', async () => {
    const lines: string[] = []
    const tracer: ApiTracer = {
      start: vi.fn((event) => lines.push(`start ${event.method} ${event.url}`)),
      finish: vi.fn((event) => lines.push(`finish ${event.status} ${event.url}`)),
      failure: vi.fn((event) => lines.push(`failure ${event.classification} ${event.url}`))
    }
    const client = createClient({
      tracer,
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            success: true,
            message: 'Registered',
            code: 'DEVICE_REGISTERED',
            data: { device: 'registered' },
            meta: {}
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' }
          }
        )
    })

    await client.request(deviceRegisterRoute, {
      company_code: 'company-acme',
      activation_code: 'activation-secret',
      token: 'actual-token',
      fingerprint_hash: 'fingerprint-secret'
    })

    expect(tracer.start).toHaveBeenCalledTimes(1)
    expect(tracer.finish).toHaveBeenCalledTimes(1)
    expect(tracer.failure).not.toHaveBeenCalled()
    expect(lines).toEqual(
      expect.arrayContaining([expect.stringContaining('/api/v1/desktop/device/register')])
    )
    expect(lines.join(' ')).not.toContain('company-acme')
    expect(lines.join(' ')).not.toContain('activation-secret')
    expect(lines.join(' ')).not.toContain('actual-token')
    expect(lines.join(' ')).not.toContain('fingerprint-secret')
  })

  it('emits one start and one failure trace event for a rejected request', async () => {
    const tracer: ApiTracer = {
      start: vi.fn(),
      finish: vi.fn(),
      failure: vi.fn()
    }
    const client = createClient({
      tracer,
      fetchImplementation: vi.fn(async () => {
        throw new Error('fetch failed')
      }) as typeof fetch
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'transport'
    })

    expect(tracer.start).toHaveBeenCalledTimes(1)
    expect(tracer.finish).not.toHaveBeenCalled()
    expect(tracer.failure).toHaveBeenCalledTimes(1)
    expect(tracer.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.objectContaining({ pathname: '/api/v1/desktop/device/register' }),
        classification: 'connection_refused'
      })
    )
  })

  it('notifies the session owner only for authenticated request failures', async () => {
    const onAuthenticatedFailure = vi.fn()
    const client = createClient({
      getAccessToken: () => 'desktop-token',
      getDeviceUuid: () => '00000000-0000-4000-8000-000000000001',
      onAuthenticatedFailure,
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            success: false,
            message: 'Session revoked.',
            code: 'SESSION_REVOKED',
            errors: {},
            meta: {}
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )
    })
    const authenticatedRoute = {
      path: '/auth/me',
      method: 'GET' as const,
      requiresAuth: true,
      requiresDeviceUuid: true
    }

    await expect(client.request(authenticatedRoute)).rejects.toMatchObject({
      backendCode: 'SESSION_REVOKED'
    })
    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      backendCode: 'SESSION_REVOKED'
    })

    expect(onAuthenticatedFailure).toHaveBeenCalledTimes(1)
    expect(onAuthenticatedFailure).toHaveBeenCalledWith(
      expect.objectContaining({ backendCode: 'SESSION_REVOKED' })
    )
  })
})
