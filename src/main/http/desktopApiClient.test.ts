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

  it('fails a protected request with a non-retryable typed local identity error', async () => {
    const fetchImplementation = vi.fn()
    const client = createClient({ fetchImplementation })
    const protectedRoute = {
      path: '/shifts/current',
      method: 'GET' as const,
      requiresAuth: true,
      requiresDeviceUuid: true
    }

    await expect(client.request(protectedRoute)).rejects.toMatchObject({
      category: 'authentication',
      backendCode: 'DESKTOP_LOCAL_IDENTITY_MISSING',
      retryable: false
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
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

  it('keeps a non-JSON HTTP response typed as an unexpected response failure', async () => {
    const client = createClient({
      fetchImplementation: async () =>
        new Response('<html>gateway error</html>', {
          status: 502,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'unexpected',
      backendCode: 'response_body_not_json',
      retryable: false,
      httpStatus: 502,
      contentType: 'text/html; charset=utf-8'
    })
  })

  it('keeps an invalid JSON envelope typed as an unexpected response failure', async () => {
    const client = createClient({
      fetchImplementation: async () =>
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'unexpected',
      backendCode: 'response_envelope_invalid',
      retryable: false
    })
  })

  it('surfaces the success envelope code and message, not only data and meta', async () => {
    // Invoice upload answers one request with two different success codes and the same body, so
    // the code is the only signal separating a fresh commit (201 DESKTOP_INVOICE_UPLOADED) from an
    // idempotent replay (200 DESKTOP_INVOICE_ALREADY_UPLOADED).
    const client = createClient({
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            success: true,
            message: 'Desktop invoice was already uploaded.',
            code: 'DESKTOP_INVOICE_ALREADY_UPLOADED',
            data: { id: 'invoice-uuid' },
            meta: { trace_id: 'trace-77' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    })

    await expect(client.requestWithMeta(deviceRegisterRoute, {})).resolves.toEqual({
      data: { id: 'invoice-uuid' },
      meta: { trace_id: 'trace-77' },
      code: 'DESKTOP_INVOICE_ALREADY_UPLOADED',
      message: 'Desktop invoice was already uploaded.'
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

  it('Phase 3: offers meta.company_access from success and error envelopes, before normalization drops meta', async () => {
    const onCompanyAccessObserved = vi.fn()
    const access = {
      company_id: '11111111-1111-4111-8111-111111111111',
      state: 'suspended',
      revision: 2,
      suspended_at: '2026-10-06T10:00:00+00:00'
    }
    const answers = [
      new Response(
        JSON.stringify({
          success: true,
          message: 'ok',
          code: 'DESKTOP_HEARTBEAT',
          data: {},
          meta: { company_access: access }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ),
      new Response(
        JSON.stringify({
          success: false,
          message: 'Suspended.',
          code: 'COMPANY_SUSPENDED',
          errors: {},
          meta: { trace_id: 't', company_access: access }
        }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      ),
      new Response(
        JSON.stringify({ success: true, message: 'ok', code: 'X', data: {}, meta: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    ]
    const client = createClient({
      getAccessToken: () => 'desktop-token',
      getDeviceUuid: () => '00000000-0000-4000-8000-000000000001',
      onCompanyAccessObserved,
      fetchImplementation: async () => answers.shift() as Response
    })
    const route = {
      path: '/device/heartbeat',
      method: 'POST' as const,
      requiresAuth: true,
      requiresDeviceUuid: true
    }

    await client.request(route, {})
    await expect(client.request(route, {})).rejects.toMatchObject({
      backendCode: 'COMPANY_SUSPENDED',
      category: 'authorization'
    })
    await client.request(route, {})

    expect(onCompanyAccessObserved).toHaveBeenCalledTimes(2)
    expect(onCompanyAccessObserved).toHaveBeenNthCalledWith(1, access)
    expect(onCompanyAccessObserved).toHaveBeenNthCalledWith(2, access)
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

  it('preserves an empty-array Laravel error payload as a shift-state conflict', async () => {
    const client = createClient({
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            success: false,
            message: 'This device already has an open shift.',
            code: 'DESKTOP_SHIFT_ALREADY_OPEN',
            errors: [],
            meta: { trace_id: 'trace-shift-already-open' }
          }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        )
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'conflict',
      retryable: false,
      backendCode: 'DESKTOP_SHIFT_ALREADY_OPEN',
      traceId: 'trace-shift-already-open'
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

  it('never reports transport_failure once an HTTP response was received, even if its body is invalid', async () => {
    const onRequestOutcome = vi.fn()
    const client = createClient({
      onRequestOutcome,
      fetchImplementation: async () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    await expect(client.request(deviceRegisterRoute)).rejects.toMatchObject({
      category: 'unexpected',
      backendCode: 'response_body_not_json'
    })

    expect(onRequestOutcome).toHaveBeenCalledTimes(1)
    expect(onRequestOutcome).toHaveBeenCalledWith({ kind: 'http_response', status: 200 })
  })

  it('with reportOutcome false, skips only the connectivity feedback; an authenticated failure is still reported', async () => {
    const onRequestOutcome = vi.fn()
    const onAuthenticatedFailure = vi.fn()
    const route = {
      path: '/product-image-assets/' + 'a'.repeat(64),
      method: 'GET',
      requiresAuth: true,
      requiresDeviceUuid: true
    } as const
    const transport = createClient({
      onRequestOutcome,
      onAuthenticatedFailure,
      getAccessToken: () => 'token',
      getDeviceUuid: () => '00000000-0000-4000-8000-000000000001',
      fetchImplementation: vi.fn(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8000')
      }) as typeof fetch
    })
    await expect(
      transport.request(route, undefined, { reportOutcome: false })
    ).rejects.toMatchObject({ category: 'transport' })

    const revoked = createClient({
      onRequestOutcome,
      onAuthenticatedFailure,
      getAccessToken: () => 'token',
      getDeviceUuid: () => '00000000-0000-4000-8000-000000000001',
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            success: false,
            message: 'Revoked.',
            code: 'UNAUTHENTICATED',
            errors: {},
            meta: {}
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )
    })
    await expect(revoked.request(route, undefined, { reportOutcome: false })).rejects.toMatchObject(
      { category: 'authentication' }
    )

    expect(onRequestOutcome).not.toHaveBeenCalled()
    expect(onAuthenticatedFailure).toHaveBeenCalledTimes(2)
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
  describe('Retry-After on 429 and 503', () => {
    const heartbeatRoute = {
      path: '/device/heartbeat',
      method: 'POST' as const,
      requiresAuth: true,
      requiresDeviceUuid: true
    }

    function errorResponse(
      status: number,
      code: string,
      headers: Record<string, string>
    ): Response {
      return new Response(
        JSON.stringify({ success: false, message: 'Slow down.', code, errors: [], meta: {} }),
        { status, headers: { 'content-type': 'application/json', ...headers } }
      )
    }

    function authenticatedClient(response: () => Response): DesktopApiClient {
      return createClient({
        getAccessToken: () => 'desktop-token',
        getDeviceUuid: () => '00000000-0000-4000-8000-000000000001',
        fetchImplementation: async () => response()
      })
    }

    it('surfaces retryAfterSeconds and httpStatus for a 429 with delta-seconds', async () => {
      const client = authenticatedClient(() =>
        errorResponse(429, 'TOO_MANY_REQUESTS', { 'retry-after': '10800' })
      )

      await expect(client.request(heartbeatRoute)).rejects.toMatchObject({
        category: 'transport',
        retryable: true,
        backendCode: 'TOO_MANY_REQUESTS',
        httpStatus: 429,
        retryAfterSeconds: 10_800
      })
    })

    it('measures a 503 HTTP-date Retry-After against the response Date header', async () => {
      const client = authenticatedClient(() =>
        errorResponse(503, 'SERVICE_UNAVAILABLE', {
          'retry-after': 'Tue, 29 Sep 2026 11:00:00 GMT',
          date: 'Tue, 29 Sep 2026 10:30:00 GMT'
        })
      )

      await expect(client.request(heartbeatRoute)).rejects.toMatchObject({
        httpStatus: 503,
        retryAfterSeconds: 1_800
      })
    })

    it('keeps the status but omits retryAfterSeconds when the header is malformed or absent', async () => {
      const headerSets: Record<string, string>[] = [{ 'retry-after': 'soon' }, {}]

      for (const headers of headerSets) {
        const client = authenticatedClient(() => errorResponse(429, 'TOO_MANY_REQUESTS', headers))
        const error = await client.request(heartbeatRoute).catch((caught: unknown) => caught)

        expect(error).toMatchObject({ httpStatus: 429 })
        expect(error).not.toHaveProperty('retryAfterSeconds')
      }
    })

    it('carries Retry-After on a non-JSON 503 maintenance page too', async () => {
      const client = authenticatedClient(
        () =>
          new Response('<html>maintenance</html>', {
            status: 503,
            headers: { 'content-type': 'text/html', 'retry-after': '120' }
          })
      )

      await expect(client.request(heartbeatRoute)).rejects.toMatchObject({
        backendCode: 'response_body_not_json',
        httpStatus: 503,
        retryAfterSeconds: 120
      })
    })

    it('ignores Retry-After on any other status', async () => {
      const client = authenticatedClient(() =>
        errorResponse(500, 'SERVER_ERROR', { 'retry-after': '120' })
      )
      const error = await client.request(heartbeatRoute).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ category: 'transport', backendCode: 'SERVER_ERROR' })
      expect(error).not.toHaveProperty('retryAfterSeconds')
      expect(error).not.toHaveProperty('httpStatus')
    })
  })
})
