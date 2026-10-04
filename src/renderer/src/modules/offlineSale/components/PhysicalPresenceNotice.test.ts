// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { OfflineSaleReadiness } from '@shared/contracts/offlineSaleReadiness.contract'
import { i18n } from '@renderer/i18n'
import PhysicalPresenceNotice from './PhysicalPresenceNotice.vue'

function readiness(overrides: Partial<OfflineSaleReadiness> = {}): OfflineSaleReadiness {
  return {
    mode: 'allocation_exclusive',
    canSellWithoutQuota: false,
    authorityUuid: null,
    notAfter: null,
    remainingSeconds: null,
    limitingReason: 'none',
    categoricalBlocks: [],
    pendingUploadCount: 0,
    lastSuccessfulSyncAt: null,
    inventoryWarnings: [],
    clockUntrusted: false,
    physicalPresenceLapsed: false,
    noTimeLimit: false,
    ...overrides
  }
}

async function render(
  data: OfflineSaleReadiness,
  locale: 'en' | 'ar' = 'en'
): Promise<ReturnType<typeof mount>> {
  Object.defineProperty(window, 'posApi', {
    configurable: true,
    value: { offlineSale: { getReadiness: async () => ({ ok: true, data }) } }
  })
  i18n.global.locale.value = locale
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(PhysicalPresenceNotice, { global: { plugins: [pinia, i18n] } })
  await flushPromises()
  return wrapper
}

describe('PhysicalPresenceNotice (Rev 4 §4.3 / A8)', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    i18n.global.locale.value = 'en'
  })

  it('renders nothing for an ordinary till', async () => {
    wrapper = await render(readiness())
    expect(wrapper.find('[data-testid^="pp-notice"]').exists()).toBe(false)
  })

  it('explains a lapsed authorization without blaming stock', async () => {
    wrapper = await render(readiness({ physicalPresenceLapsed: true }))
    expect(wrapper.find('[data-testid="pp-notice-lapsed"]').text()).toContain(
      String(i18n.global.t('offlineSale.notice.lapsedTitle'))
    )
  })

  it('an untrusted clock takes precedence, in Arabic too', async () => {
    wrapper = await render(readiness({ physicalPresenceLapsed: true, clockUntrusted: true }), 'ar')
    const notice = wrapper.find('[data-testid="pp-notice-clock"]')
    expect(notice.text()).toContain('لا يمكن الوثوق بساعة هذا الجهاز')
    expect(wrapper.find('[data-testid="pp-notice-lapsed"]').exists()).toBe(false)
  })
})
