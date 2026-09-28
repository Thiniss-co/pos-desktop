// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import { useReceiptProfileStore } from '../store'
import ReceiptProfileSection from './ReceiptProfileSection.vue'

/*
 * The editor once shipped with no `receiptProfile.*` catalog entries, so every label rendered as
 * its raw key. vue-i18n does not fail on a missing key, so only a render-level check catches it.
 */

async function renderSection(options: {
  locale: 'en' | 'ar'
  connectivity?: 'online' | 'offline'
}): Promise<{
  wrapper: ReturnType<typeof mount>
  store: ReturnType<typeof useReceiptProfileStore>
}> {
  i18n.global.locale.value = options.locale
  const pinia = createPinia()
  setActivePinia(pinia)

  const store = useReceiptProfileStore()
  store.state = {
    capability: 'supported',
    canManage: true,
    profile: {
      versionUuid: '6f1c7a52-3b1e-4c1a-9d0e-2a4b5c6d7e8f',
      revision: 3,
      addressLines: ['12 Tahrir Street, Downtown', 'Cairo'],
      phone: '+20 2 2345 6789',
      taxIdentifierLabel: 'Tax reg. no.',
      taxIdentifierValue: '100-234-567',
      footerLines: ['Thank you for shopping with us'],
      logo: null
    },
    logo: null
  }
  store.draft = {
    addressLines: ['12 Tahrir Street, Downtown', 'Cairo'],
    phone: '+20 2 2345 6789',
    taxIdentifierLabel: 'Tax reg. no.',
    taxIdentifierValue: '100-234-567',
    footerLines: ['Thank you for shopping with us']
  }

  const connectivity = useConnectivityStore()
  connectivity.snapshot = {
    status: options.connectivity ?? 'online',
    networkAvailable: options.connectivity !== 'offline',
    backendReachable: options.connectivity !== 'offline',
    checkedAt: null,
    lastBackendReachableAt: null,
    reason: 'probe_succeeded'
  }

  const wrapper = mount(ReceiptProfileSection, { global: { plugins: [pinia, i18n] } })
  await flushPromises()

  return { wrapper, store }
}

describe('ReceiptProfileSection translations', () => {
  let mounted: ReturnType<typeof mount> | null = null

  afterEach(() => {
    mounted?.unmount()
    mounted = null
    i18n.global.locale.value = 'en'
  })

  it.each(['en', 'ar'] as const)(
    'renders %s labels instead of raw catalog keys',
    async (locale) => {
      const { wrapper } = await renderSection({ locale, connectivity: 'offline' })
      mounted = wrapper

      expect(wrapper.html()).not.toContain('receiptProfile.')
      expect(wrapper.get('h2').text()).toBe(String(i18n.global.t('receiptProfile.title')))
      expect(wrapper.text()).toContain(
        String(i18n.global.t('receiptProfile.addressLineNumberLabel', { number: 2 }))
      )
      expect(wrapper.text()).toContain(String(i18n.global.t('receiptProfile.offlineNotice')))
    }
  )

  it.each(['en', 'ar'] as const)(
    'localizes a receipt-profile backend error in %s instead of the raw server text',
    async (locale) => {
      const { wrapper, store } = await renderSection({ locale })
      mounted = wrapper

      store.error.setDetail({
        category: 'validation',
        message: 'Raw server text',
        backendCode: 'RECEIPT_PROFILE_ASSET_INVALID',
        retryable: false
      })
      await wrapper.vm.$nextTick()

      const banner = wrapper.get('.app-banner--error')
      expect(banner.text()).toBe(String(i18n.global.t('errors.RECEIPT_PROFILE_ASSET_INVALID')))
      expect(banner.text()).not.toContain('Raw server text')
    }
  )
})
