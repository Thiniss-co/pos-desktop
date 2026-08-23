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

  it('never probes, schedules, or emits when no API origin is configured', async () => {
    const fetchImplementation = vi.fn(async () => healthyResponse())
    const onChange = vi.fn()
    const service = new ConnectivityService({
      apiOrigin: null,
      isOnline: () => true,
      fetchImplementation: fetchImplementation as typeof fetch,
      onChange
    })

    expect(service.getSnapshot()).toMatchObject({ status: 'checking', reason: 'unknown' })

    service.start()
    await service.checkNow()

    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(service.getSnapshot()).toMatchObject({ status: 'checking', reason: 'unknown' })
  })

  it('never follows a redirect into looking healthy', async () => {
    const fetchImplementation = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => healthyResponse())
    const service = createService({ fetchImplementation: fetchImplementation as typeof fetch })

    await service.checkNow()

    const [, init] = fetchImplementation.mock.calls[0] ?? []
    expect(init?.redirect).toBe('manual')
  })

  it('treats a 200 response with a malformed body as unhealthy rather than crashing', async () => {
    const service = createService({
      fetchImplementation: vi.fn(
        async () =>
          new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })
      ) as typeof fetch
    })

    await expect(service.checkNow()).resolves.toMatchObject({
      status: 'backend_unreachable',
      reason: 'probe_unhealthy'
    })
  })

  it('removes the resume listener it registered, by the same identity, on shutdown', () => {
    let registered: (() => void) | null = null
    const removed: Array<() => void> = []
    const service = createService({
      onResume: (listener) => {
        registered = listener
        return () => {
          removed.push(listener)
        }
      }
    })

    service.start()
    expect(registered).not.toBeNull()

    service.shutdown()

    expect(removed).toEqual([registered])
  })

  it('reports lastBackendReachableAt from a business-request outcome without touching checkedAt', async () => {
    const service = createService({ isOnline: () => false })

    await service.checkNow()
    const before = service.getSnapshot()
    expect(before.status).toBe('offline')
    expect(before.checkedAt).not.toBeNull()
    expect(before.lastBackendReachableAt).toBeNull()

    service.reportRequestOutcome({ kind: 'http_response', status: 200 })
    const after = service.getSnapshot()

    // checkedAt is reserved for the /up probe's own timestamp; a business-request outcome must
    // not blur that meaning by refreshing it too.
    expect(after.checkedAt).toBe(before.checkedAt)
    expect(after.lastBackendReachableAt).not.toBeNull()
  })

  it('throttles request-driven rechecks the same as a manual retry, instead of bypassing the minimum gap', async () => {
    const fetchImplementation = vi.fn(
      async () => new Response('down', { status: 503 })
    ) as typeof fetch
    const service = createService({ fetchImplementation, checkNowMinGapMs: 2_000 })

    await service.checkNow()
    expect(fetchImplementation).toHaveBeenCalledTimes(1)

    // A burst of transport failures arriving well inside the minimum gap must not each trigger
    // their own /up probe — only startup, resume, and an explicit user retry may bypass the gap.
    for (let i = 0; i < 5; i += 1) {
      service.reportRequestOutcome({ kind: 'transport_failure' })
    }
    await Promise.resolve()

    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('caps the backoff delay after jitter is applied, never exceeding backoffMaxMs', async () => {
    vi.useFakeTimers()
    const fetchImplementation = vi.fn(
      async () => new Response('down', { status: 503 })
    ) as typeof fetch
    const service = createService({
      fetchImplementation,
      random: () => 1, // maximum jitter multiplier (1.2x)
      backoffBaseMs: 1_000,
      backoffMaxMs: 5_000
    })

    service.start()
    await vi.runAllTicks() // failure #1 -> next delay 1000 * 1.2 = 1200ms

    await vi.advanceTimersByTimeAsync(1_200) // failure #2 -> next delay 2000 * 1.2 = 2400ms
    await vi.advanceTimersByTimeAsync(2_400) // failure #3 -> next delay 4000 * 1.2 = 4800ms
    await vi.advanceTimersByTimeAsync(4_800) // failure #4 -> raw 8000 * 1.2 = 9600ms, capped to 5000ms
    expect(fetchImplementation).toHaveBeenCalledTimes(4)

    // If the cap were applied before jitter (the pre-fix behavior), this delay would instead be
    // round(min(8000, 5000) * 1.2) = 6000ms, and the probe would not have fired yet at 5000ms.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchImplementation).toHaveBeenCalledTimes(5)
  })
})
