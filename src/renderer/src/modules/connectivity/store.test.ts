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

  it('subscribes once, presents separate warnings, and shows a restored toast after offline', async () => {
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

    await Promise.all([store.initialize(service), store.initialize(service)])
    listener?.(snapshot('offline', 'network_offline'))

    expect(store.showOfflineWarning).toBe(true)
    expect(store.showBackendUnavailableWarning).toBe(false)

    listener?.(snapshot('online', 'probe_succeeded'))

    expect(store.showOfflineWarning).toBe(false)
    expect(store.showRestoredToast).toBe(true)
  })

  it('announces a backend restoration without treating it as an offline toast', async () => {
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
    listener?.(snapshot('online', 'probe_succeeded'))

    expect(restored).toHaveBeenCalledTimes(1)
    expect(store.showRestoredToast).toBe(false)
  })
})
