// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import { ConnectivityGatewayService, type ConnectivityGateway } from './service'
import { useConnectivityStore } from './store'

function snapshot(
  status: ConnectivitySnapshot['status'],
  reason: ConnectivitySnapshot['reason']
): ConnectivitySnapshot {
  return {
    status,
    networkAvailable: status === 'offline' ? false : true,
    backendReachable: status === 'online' ? true : status === 'offline' ? null : false,
    checkedAt: '2026-01-01T00:00:00Z',
    lastBackendReachableAt: status === 'online' ? '2026-01-01T00:00:00Z' : null,
    reason
  }
}

describe('useConnectivityStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes exactly once even when initialize() is called concurrently', async () => {
    const onChanged = vi.fn(() => vi.fn())
    const gateway: ConnectivityGateway = {
      getState: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      checkNow: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      onChanged
    }
    const service = new ConnectivityGatewayService(gateway)
    const store = useConnectivityStore()

    await Promise.all([
      store.initialize(service),
      store.initialize(service),
      store.initialize(service)
    ])

    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('presents separate warnings, and shows a restored toast after offline', async () => {
    let listener: ((next: ConnectivitySnapshot) => void) | undefined
    const gateway: ConnectivityGateway = {
      getState: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      checkNow: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      onChanged: (nextListener) => {
        listener = nextListener
        return vi.fn()
      }
    }
    const service = new ConnectivityGatewayService(gateway)
    const store = useConnectivityStore()

    await store.initialize(service)
    listener?.(snapshot('offline', 'network_offline'))

    expect(store.showOfflineWarning).toBe(true)
    expect(store.showBackendUnavailableWarning).toBe(false)

    listener?.(snapshot('online', 'probe_succeeded'))

    expect(store.showOfflineWarning).toBe(false)
    expect(store.showRestoredToast).toBe(true)
  })

  it('shows the restored toast through the real offline -> checking -> online sequence', async () => {
    // The main-process service always passes through an intermediate `checking` snapshot on its
    // way from `offline` back to `online` (see connectivity.service.ts's runProbe). A store that
    // only compared against the immediately preceding status would see checking -> online, not
    // offline -> online, and never show the toast — regression test for that exact bug.
    let listener: ((next: ConnectivitySnapshot) => void) | undefined
    const gateway: ConnectivityGateway = {
      getState: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      checkNow: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      onChanged: (nextListener) => {
        listener = nextListener
        return vi.fn()
      }
    }
    const store = useConnectivityStore()

    await store.initialize(new ConnectivityGatewayService(gateway))
    listener?.(snapshot('offline', 'network_offline'))
    listener?.(snapshot('checking', 'startup'))
    listener?.(snapshot('online', 'probe_succeeded'))

    expect(store.showRestoredToast).toBe(true)
  })

  it('announces a backend restoration through checking, without treating it as an offline toast', async () => {
    let listener: ((next: ConnectivitySnapshot) => void) | undefined
    const gateway: ConnectivityGateway = {
      getState: async () => ({
        ok: true,
        data: snapshot('backend_unreachable', 'probe_unhealthy')
      }),
      checkNow: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      onChanged: (nextListener) => {
        listener = nextListener
        return vi.fn()
      }
    }
    const store = useConnectivityStore()
    const restored = vi.fn()
    store.onBackendRestored(restored)

    await store.initialize(new ConnectivityGatewayService(gateway))
    listener?.(snapshot('checking', 'startup'))
    listener?.(snapshot('online', 'probe_succeeded'))

    expect(restored).toHaveBeenCalledTimes(1)
    expect(store.showRestoredToast).toBe(false)
  })

  it('does not let a stale getState() reply overwrite a snapshot pushed while it was in flight', async () => {
    // Regression test: initialize() subscribes first, then awaits getState(). If a push lands
    // before that getState() reply resolves, applying the reply afterwards would silently revert
    // the store to the older state and, since main only re-emits on a *meaningful* change, the UI
    // could be stuck showing it indefinitely.
    let listener: ((next: ConnectivitySnapshot) => void) | undefined
    let resolveGetState: ((snapshot: ConnectivitySnapshot) => void) | undefined
    const gateway: ConnectivityGateway = {
      getState: () =>
        new Promise((resolve) => {
          resolveGetState = (value) => resolve({ ok: true, data: value })
        }),
      checkNow: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      onChanged: (nextListener) => {
        listener = nextListener
        return vi.fn()
      }
    }
    const store = useConnectivityStore()

    const initializing = store.initialize(new ConnectivityGatewayService(gateway))

    // A newer snapshot arrives through the push channel while getState() is still in flight.
    listener?.(snapshot('online', 'probe_succeeded'))
    expect(store.snapshot?.status).toBe('online')

    // The slow getState() reply finally resolves with the older, now-stale snapshot.
    resolveGetState?.(snapshot('checking', 'startup'))
    await initializing

    expect(store.snapshot?.status).toBe('online')
  })

  it('does not let a stale checkNow() reply overwrite a snapshot pushed while retry() was in flight', async () => {
    let listener: ((next: ConnectivitySnapshot) => void) | undefined
    let resolveCheckNow: ((snapshot: ConnectivitySnapshot) => void) | undefined
    const gateway: ConnectivityGateway = {
      getState: async () => ({ ok: true, data: snapshot('offline', 'network_offline') }),
      checkNow: () =>
        new Promise((resolve) => {
          resolveCheckNow = (value) => resolve({ ok: true, data: value })
        }),
      onChanged: (nextListener) => {
        listener = nextListener
        return vi.fn()
      }
    }
    const service = new ConnectivityGatewayService(gateway)
    const store = useConnectivityStore()

    await store.initialize(service)
    const retrying = store.retry(service)

    listener?.(snapshot('backend_unreachable', 'probe_unhealthy'))
    resolveCheckNow?.(snapshot('offline', 'network_offline'))
    await retrying

    expect(store.snapshot?.status).toBe('backend_unreachable')
    expect(store.isRetrying).toBe(false)
  })

  it('lets a fresh initialize() call retry after a failed one, instead of caching the rejection', async () => {
    const gateway: ConnectivityGateway = {
      getState: vi
        .fn()
        .mockRejectedValueOnce(new Error('IPC unavailable'))
        .mockResolvedValue({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      checkNow: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      onChanged: () => vi.fn()
    }
    const service = new ConnectivityGatewayService(gateway)
    const store = useConnectivityStore()

    await expect(store.initialize(service)).rejects.toBeTruthy()
    await expect(store.initialize(service)).resolves.toBeUndefined()

    expect(store.snapshot?.status).toBe('online')
  })

  it('dispose() removes the push subscription so a later event cannot reach a torn-down store', async () => {
    let unsubscribeCalls = 0
    let listener: ((next: ConnectivitySnapshot) => void) | undefined
    const gateway: ConnectivityGateway = {
      getState: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      checkNow: async () => ({ ok: true, data: snapshot('online', 'probe_succeeded') }),
      onChanged: (nextListener) => {
        listener = nextListener
        return () => {
          unsubscribeCalls += 1
          listener = undefined
        }
      }
    }
    const store = useConnectivityStore()

    await store.initialize(new ConnectivityGatewayService(gateway))
    store.dispose()

    expect(unsubscribeCalls).toBe(1)
    expect(listener).toBeUndefined()
  })
})
