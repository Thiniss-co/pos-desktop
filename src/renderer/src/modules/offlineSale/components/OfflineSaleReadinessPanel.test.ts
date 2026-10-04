// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { OfflineSaleReadiness } from '@shared/contracts/offlineSaleReadiness.contract'
import { i18n } from '@renderer/i18n'
import OfflineSaleReadinessPanel from './OfflineSaleReadinessPanel.vue'

/*
 * The panel binds AppStatusChip / AppBanner through `variant`. A blocking reason must read as an
 * error, the advisory inventory warning as info, and an untrusted clock as a warning — three
 * visually distinct states, never one neutral colour.
 */

function readiness(overrides: Partial<OfflineSaleReadiness> = {}): OfflineSaleReadiness {
  return {
    mode: 'physical_presence',
    canSellWithoutQuota: true,
    authorityUuid: '11111111-1111-4111-8111-111111111111',
    notAfter: '2026-09-12T10:00:00Z',
    remainingSeconds: 5 * 3600,
    limitingReason: 'authority_ceiling',
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

async function renderPanel(
  getReadiness: () => Promise<unknown>,
  locale: 'en' | 'ar' = 'en'
): Promise<ReturnType<typeof mount>> {
  Object.defineProperty(window, 'posApi', {
    configurable: true,
    value: { offlineSale: { getReadiness } }
  })
  i18n.global.locale.value = locale
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(OfflineSaleReadinessPanel, { global: { plugins: [pinia, i18n] } })
  await flushPromises()

  return wrapper
}

describe('OfflineSaleReadinessPanel status rendering', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    i18n.global.locale.value = 'en'
  })

  it('shows a usable authority as success and a missing one as neutral', async () => {
    wrapper = await renderPanel(async () => ({ ok: true, data: readiness() }))
    expect(wrapper.get('.app-status-chip').classes()).toContain('app-status-chip--success')
    expect(wrapper.text()).toContain(String(i18n.global.t('offlineSale.noPreparationNeeded')))
    wrapper.unmount()

    wrapper = await renderPanel(async () => ({
      ok: true,
      data: readiness({ canSellWithoutQuota: false, mode: 'allocation_exclusive' })
    }))
    expect(wrapper.get('.app-status-chip').classes()).toContain('app-status-chip--neutral')
    expect(wrapper.text()).not.toContain(String(i18n.global.t('offlineSale.noPreparationNeeded')))
  })

  it('keeps blocks, clock warnings and inventory advisories visually distinct', async () => {
    wrapper = await renderPanel(async () => ({
      ok: true,
      data: readiness({
        clockUntrusted: true,
        categoricalBlocks: ['device-revoked'],
        inventoryWarnings: [
          {
            productUuid: '22222222-2222-4222-8222-222222222222',
            productName: 'Juhayna Milk 1L',
            cachedQuantityMilli: 0,
            atOrBelowZero: true
          }
        ]
      })
    }))

    const variants = wrapper.findAll('.app-banner').map((banner) => banner.classes())
    expect(variants.some((c) => c.includes('app-banner--warning'))).toBe(true)
    expect(variants.some((c) => c.includes('app-banner--error'))).toBe(true)
    expect(variants.some((c) => c.includes('app-banner--info'))).toBe(true)
  })

  it.each(['en', 'ar'] as const)(
    'names categorical blocks in %s instead of printing main-process tokens',
    async (locale) => {
      wrapper = await renderPanel(
        async () => ({
          ok: true,
          data: readiness({
            canSellWithoutQuota: false,
            categoricalBlocks: ['shift-not-open', 'something-new']
          })
        }),
        locale
      )

      const banner = wrapper.get('.app-banner--error')
      expect(banner.text()).toContain(
        String(i18n.global.t('offlineSale.categoricalBlock.shift-not-open'))
      )
      expect(banner.text()).toContain(String(i18n.global.t('offlineSale.categoricalBlock.unknown')))
      expect(banner.text()).not.toContain('shift-not-open')
      expect(banner.text()).not.toContain('something-new')
    }
  )

  it('shows a localized first-load failure with a retry that recovers', async () => {
    let calls = 0
    wrapper = await renderPanel(async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('ipc exploded')
      }

      return { ok: true, data: readiness() }
    })

    const alert = wrapper.get('[data-testid="offline-sale-readiness-error"]')
    expect(alert.text()).toBe(String(i18n.global.t('offlineSale.readinessUnavailable')))
    expect(alert.text()).not.toContain('ipc exploded')

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(calls).toBe(2)
    expect(wrapper.find('[data-testid="offline-sale-readiness-error"]').exists()).toBe(false)
    expect(wrapper.get('.app-status-chip').classes()).toContain('app-status-chip--success')
  })

  it('shows "no offline time limit" instead of a multi-year countdown', async () => {
    wrapper = await renderPanel(async () => ({
      ok: true,
      data: readiness({ noTimeLimit: true, remainingSeconds: 360_000_000 })
    }))
    expect(wrapper.text()).toContain(String(i18n.global.t('offlineSale.noTimeLimit')))
    expect(wrapper.text()).not.toContain('100000h')
  })
})
