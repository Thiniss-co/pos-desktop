// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import { i18n } from '@renderer/i18n'
import { ConnectivityGatewayService, type ConnectivityGateway } from '../service'
import { useConnectivityStore } from '../store'
import ConnectivityBanner from './ConnectivityBanner.vue'

function snapshot(status: ConnectivitySnapshot['status']): ConnectivitySnapshot {
  return {
    status,
    networkAvailable: status === 'offline' ? false : true,
    backendReachable: status === 'online' ? true : status === 'offline' ? null : false,
    checkedAt: null,
    lastBackendReachableAt: null,
    reason: status === 'offline' ? 'network_offline' : 'probe_unhealthy'
  }
}

describe('ConnectivityBanner', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    i18n.global.locale.value = 'en'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders distinct document-flow warnings for offline and backend-unavailable states', async () => {
    const store = useConnectivityStore()
    const wrapper = mount(ConnectivityBanner, { global: { plugins: [pinia, i18n] } })

    store.snapshot = snapshot('offline')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="alert"]').text()).toContain('offline')
    expect(wrapper.get('button').element.tagName).toBe('BUTTON')

    store.snapshot = snapshot('backend_unreachable')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="alert"]').text()).toContain('network is available')
  })

  it('renders nothing for a healthy online snapshot', async () => {
    const store = useConnectivityStore()
    const wrapper = mount(ConnectivityBanner, { global: { plugins: [pinia, i18n] } })

    store.snapshot = snapshot('online')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })

  it('shows the checking hint only after its 2s delay, as role="status" not role="alert"', async () => {
    vi.useFakeTimers()
    const gateway: ConnectivityGateway = {
      getState: async () => ({ ok: true, data: snapshot('checking') }),
      checkNow: async () => ({ ok: true, data: snapshot('online') }),
      onChanged: () => vi.fn()
    }
    const store = useConnectivityStore()
    const wrapper = mount(ConnectivityBanner, { global: { plugins: [pinia, i18n] } })

    await store.initialize(new ConnectivityGatewayService(gateway))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="status"]').exists()).toBe(false)

    await vi.advanceTimersByTimeAsync(2_000)
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="status"]').text()).toContain('Checking')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('shows the restored toast as role="status" after a real offline -> online recovery', async () => {
    vi.useFakeTimers()
    let listener: ((next: ConnectivitySnapshot) => void) | undefined
    const gateway: ConnectivityGateway = {
      getState: async () => ({ ok: true, data: snapshot('offline') }),
      checkNow: async () => ({ ok: true, data: snapshot('online') }),
      onChanged: (nextListener) => {
        listener = nextListener
        return vi.fn()
      }
    }
    const store = useConnectivityStore()
    const wrapper = mount(ConnectivityBanner, { global: { plugins: [pinia, i18n] } })

    await store.initialize(new ConnectivityGatewayService(gateway))
    listener?.(snapshot('online'))
    await wrapper.vm.$nextTick()

    const status = wrapper.get('[role="status"]')
    expect(status.text()).toContain('restored')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('disables Retry while retrying and re-enables it once the retry settles', async () => {
    // The template calls `connectivity.retry()` with no arguments (its default gateway reads
    // `window.posApi`, which is not stubbed for these component tests), so the store action is
    // substituted directly here — a store's actions are ordinary reassignable properties on the
    // Pinia proxy, and this keeps the test focused on the button's disabled/isRetrying wiring
    // rather than re-plumbing a global posApi stub.
    let resolveRetry: (() => void) | undefined
    const store = useConnectivityStore()
    store.snapshot = snapshot('offline')
    store.retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          store.isRetrying = true
          resolveRetry = () => {
            store.isRetrying = false
            resolve()
          }
        })
    )
    const wrapper = mount(ConnectivityBanner, { global: { plugins: [pinia, i18n] } })

    const button = wrapper.get('button')
    expect(button.attributes('disabled')).toBeUndefined()

    await button.trigger('click')
    await wrapper.vm.$nextTick()

    expect(store.retry).toHaveBeenCalledTimes(1)
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()

    resolveRetry?.()
    await wrapper.vm.$nextTick()

    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
  })
})
