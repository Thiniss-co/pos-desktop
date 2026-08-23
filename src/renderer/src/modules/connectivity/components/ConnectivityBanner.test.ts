// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import { i18n } from '@renderer/i18n'
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
  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    i18n.global.locale.value = 'en'
  })

  it('renders distinct document-flow warnings for offline and backend-unavailable states', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
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
})
