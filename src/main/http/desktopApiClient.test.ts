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

  it('preserves a real Laravel domain error instead of collapsing it into a generic transport failure', async () => {
    // Regression test for the exact activation bug: Laravel's ApiResponse::error() sends
    // `errors: null` (verified against the live desktop/device/register route) for every
    // non-validation error. Before the envelope schema normalized that null, this response
    // failed envelope parsing, was caught as a plain (non-PublicAppError) Error, and fell
    // through to the transport-failure default: category "transport", message "The desktop
    // service request failed", retryable true — hiding the real INVALID_CREDENTIALS rejection.
    const client = createClient({
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            success: false,
            message: 'Invalid company code or activation code.',
            code: 'INVALID_CREDENTIALS',
            errors: null,
            meta: { trace_id: 'trace-invalid-credentials' }
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'authentication',
      retryable: false,
      backendCode: 'INVALID_CREDENTIALS',
      message: 'Invalid company code or activation code.'
    })
  })

  it('preserves a device-limit FORBIDDEN denial instead of collapsing it into a transport failure', async () => {
    // Same schema bug, hit via the device-registration-limit rejection path (Laravel returns
    // 403 FORBIDDEN with errors: null when RegisterDeviceAction's device === null).
    const client = createClient({
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            success: false,
            message: 'The device limit for this plan has been reached.',
            code: 'FORBIDDEN',
            errors: null,
            meta: { trace_id: 'trace-forbidden', access: { can_activate_device: false } }
          }),
          { status: 403, headers: { 'content-type': 'application/json' } }
        )
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'authorization',
      retryable: false,
      backendCode: 'FORBIDDEN',
      message: 'The device limit for this plan has been reached.'
    })
  })
})

describe('DesktopApiClient connectivity outcome reporting', () => {
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

  it('reports an http_response outcome for a normal response, even an error envelope', async () => {
    const onRequestOutcome = vi.fn()
    const client = createClient({
      onRequestOutcome,
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            success: false,
            message: 'Not found.',
            code: 'NOT_FOUND',
            errors: {},
            meta: {}
          }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        )
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      backendCode: 'NOT_FOUND'
    })

    expect(onRequestOutcome).toHaveBeenCalledTimes(1)
    expect(onRequestOutcome).toHaveBeenCalledWith({ kind: 'http_response', status: 404 })
  })

  it('reports a transport_failure outcome only when no HTTP response was ever received', async () => {
    const onRequestOutcome = vi.fn()
    const client = createClient({
      onRequestOutcome,
      fetchImplementation: vi.fn(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8000')
      }) as typeof fetch
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'transport'
    })

    expect(onRequestOutcome).toHaveBeenCalledTimes(1)
    expect(onRequestOutcome).toHaveBeenCalledWith({ kind: 'transport_failure' })
  })

  it('never reports transport_failure once an HTTP response was received, even if it then fails', async () => {
    const onRequestOutcome = vi.fn()
    const client = createClient({
      onRequestOutcome,
      fetchImplementation: async () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toBeTruthy()

    expect(onRequestOutcome).toHaveBeenCalledTimes(1)
    expect(onRequestOutcome).toHaveBeenCalledWith({ kind: 'http_response', status: 200 })
  })

  it('cannot corrupt the business result if the connectivity callback throws', async () => {
    const client = createClient({
      onRequestOutcome: () => {
        throw new Error('connectivity service exploded')
      },
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            success: true,
            message: 'Registered',
            code: 'DEVICE_REGISTERED',
            data: { device: 'registered' },
            meta: {}
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
    })

    await expect(client.request(deviceRegisterRoute)).resolves.toEqual({ device: 'registered' })
  })

  it('cannot turn a real error into a different error if the connectivity callback throws', async () => {
    const client = createClient({
      onRequestOutcome: () => {
        throw new Error('connectivity service exploded')
      },
      fetchImplementation: vi.fn(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8000')
      }) as typeof fetch
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'transport',
      message: 'The desktop service refused the connection'
    })
  })
})
