import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiTracer } from '../http/apiTrace'
import { ConnectivityService } from './connectivity.service'

function healthyResponse(): Response {
  return new Response(JSON.stringify({ status: 'up' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function createService(
  overrides: Partial<ConstructorParameters<typeof ConnectivityService>[0]> = {}
): ConnectivityService {
  return new ConnectivityService({
    apiOrigin: new URL('https://api.example.test'),
    isOnline: () => true,
    fetchImplementation: vi.fn(async () => healthyResponse()) as typeof fetch,
    random: () => 0.5,
    ...overrides
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ConnectivityService', () => {
  it('starts checking and transitions to online with an unauthenticated /up request', async () => {
    const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => healthyResponse()
    )
    const service = createService({ fetchImplementation: fetchSpy as typeof fetch })

    expect(service.getSnapshot()).toMatchObject({
      status: 'checking',
      networkAvailable: null,
      backendReachable: null,
      reason: 'startup'
    })

    const snapshot = await service.checkNow()
    const [, init] = fetchSpy.mock.calls[0] ?? []

    expect(snapshot).toMatchObject({
      status: 'online',
      networkAvailable: true,
      backendReachable: true,
      reason: 'probe_succeeded'
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ pathname: '/up' }))
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    expect(new Headers(init?.headers).has('X-Device-UUID')).toBe(false)
  })

  it('distinguishes an offline machine from an unhealthy backend', async () => {
    const offline = createService({ isOnline: () => false })
    const unhealthy = createService({
      fetchImplementation: vi.fn(async () => new Response('down', { status: 503 })) as typeof fetch
    })

    await expect(offline.checkNow()).resolves.toMatchObject({
      status: 'offline',
      networkAvailable: false,
      backendReachable: null,
      reason: 'network_offline'
    })
    await expect(unhealthy.checkNow()).resolves.toMatchObject({
      status: 'backend_unreachable',
      networkAvailable: true,
      backendReachable: false,
      reason: 'probe_unhealthy'
    })
  })

  it('coalesces concurrent checks and rate-limits later user retries', async () => {
    let resolveProbe: ((value: Response) => void) | undefined
    const fetchImplementation = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveProbe = resolve
        })
    ) as typeof fetch
    const service = createService({ fetchImplementation })

    const first = service.checkNow()
    const second = service.checkNow()

    expect(second).toBe(first)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)

    resolveProbe?.(healthyResponse())
    await first
    await service.checkNow()

    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('backs off failed probes and does not emit unchanged healthy snapshots repeatedly', async () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    const fetchImplementation = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockImplementation(async () => healthyResponse())
    const service = createService({
      fetchImplementation: fetchImplementation as typeof fetch,
      onChange
    })

    service.start()
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(service.getSnapshot().status).toBe('online')
    expect(onChange).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(30_000)

    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight probe during shutdown and never emits the aborted result', async () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    const fetchImplementation = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        })
    ) as typeof fetch
    const service = createService({ fetchImplementation, onChange })

    const probe = service.checkNow()
    service.shutdown()
    await vi.runAllTimersAsync()
    await probe

    expect(onChange).not.toHaveBeenCalled()
    expect(service.getSnapshot().status).toBe('checking')
  })

  it('traces health probes without creating a new logging mechanism', async () => {
    const tracer: ApiTracer = { start: vi.fn(), finish: vi.fn(), failure: vi.fn() }
    const service = createService({ tracer })

    await service.checkNow()

    expect(tracer.start).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: expect.objectContaining({ pathname: '/up' }) })
    )
    expect(tracer.finish).toHaveBeenCalledTimes(1)
  })
})
