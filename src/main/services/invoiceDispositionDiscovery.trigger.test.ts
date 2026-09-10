import { describe, expect, it, vi } from 'vitest'
import { DispositionDiscoveryTrigger } from './invoiceDispositionDiscovery.trigger'

describe('PS6b bounded discovery triggers', () => {
  it('coalesces overlapping triggers into one run', async () => {
    // §7.3a.5: runs are main-owned and BOUNDED. Overlapping reconnect events must not each start a
    // run — a reconnect storm would otherwise turn a convergence step into a request loop.
    const run = vi.fn().mockResolvedValue(undefined)
    const trigger = new DispositionDiscoveryTrigger({ run, minimumIntervalMs: 0, now: () => 0 })

    await Promise.all([
      trigger.request('startup'),
      trigger.request('reconnect'),
      trigger.request('manual')
    ])

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('enforces a minimum interval between runs', async () => {
    let clock = 0
    const run = vi.fn().mockResolvedValue(undefined)
    const trigger = new DispositionDiscoveryTrigger({
      run,
      minimumIntervalMs: 60_000,
      now: () => clock
    })

    await trigger.request('startup')
    clock = 30_000
    await trigger.request('reconnect')

    // Still inside the window: refused, not queued.
    expect(run).toHaveBeenCalledTimes(1)

    clock = 61_000
    await trigger.request('reconnect')

    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not start a run when access is unavailable', async () => {
    // §7.3a.5: every run rechecks sync access, permission and owner BEFORE the request.
    const run = vi.fn().mockResolvedValue(undefined)
    const trigger = new DispositionDiscoveryTrigger({
      run,
      minimumIntervalMs: 0,
      now: () => 0,
      canRun: () => false
    })

    await trigger.request('startup')

    expect(run).not.toHaveBeenCalled()
  })

  it('releases the in-flight lock even when a run throws', async () => {
    // A failed run must not wedge discovery permanently — that would be a silent, unrecoverable
    // stop rather than a bounded one.
    let clock = 0
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const trigger = new DispositionDiscoveryTrigger({
      run,
      minimumIntervalMs: 0,
      now: () => clock
    })

    await trigger.request('startup')
    clock = 1
    await trigger.request('reconnect')

    expect(run).toHaveBeenCalledTimes(2)
  })
})
