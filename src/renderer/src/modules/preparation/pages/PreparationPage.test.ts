// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { OfflineSaleReadiness } from '@shared/contracts/offlineSaleReadiness.contract'
import type { PreparationReadiness } from '@shared/contracts/preparation.contract'
import { i18n } from '@renderer/i18n'
import PreparationPage from './PreparationPage.vue'

const KNOWN_PRODUCT = '0a1b2c3d-0000-4000-8000-000000000001'
const UNKNOWN_PRODUCT = '0a1b2c3d-0000-4000-8000-000000000002'

function readiness(
  time: Partial<PreparationReadiness['time']> = {},
  rest: Partial<Omit<PreparationReadiness, 'time'>> = {}
): PreparationReadiness {
  return {
    available: true,
    time: {
      state: 'counting_down',
      preparedAt: '2026-09-09T10:00:00Z',
      requestedDurationSeconds: 259_200,
      originalResult: 'ready_72h',
      effectiveReadyUntil: '2026-09-12T10:00:00Z',
      remainingSeconds: 70 * 3600,
      limitingReason: 'required_window',
      tiedLimitingReasons: ['required_window'],
      newlyObservedRestriction: null,
      lastTrustedObservationAt: '2026-09-09T10:00:00Z',
      ...time
    },
    quantity: { state: 'full', products: [] },
    blockedProducts: [],
    unresolvedOperations: [],
    ...rest
  }
}

const PHYSICAL_PRESENCE: OfflineSaleReadiness = {
  mode: 'physical_presence',
  canSellWithoutQuota: true,
  authorityUuid: '11111111-1111-4111-8111-111111111111',
  notAfter: '2026-09-12T10:00:00Z',
  remainingSeconds: 3 * 3600,
  limitingReason: 'authority_ceiling',
  categoricalBlocks: [],
  pendingUploadCount: 2,
  lastSuccessfulSyncAt: null,
  inventoryWarnings: [],
  clockUntrusted: false,
  physicalPresenceLapsed: false,
  noTimeLimit: false
}

const ALLOCATION_ONLY: OfflineSaleReadiness = {
  ...PHYSICAL_PRESENCE,
  mode: 'allocation_exclusive',
  canSellWithoutQuota: false,
  authorityUuid: null,
  notAfter: null,
  remainingSeconds: null,
  limitingReason: 'none'
}

function installPosApi(
  getReadiness: () => Promise<unknown>,
  offlineSale: OfflineSaleReadiness = ALLOCATION_ONLY
): void {
  Object.defineProperty(window, 'posApi', {
    configurable: true,
    value: {
      preparation: {
        getReadiness,
        runCycle: async () => ({ ok: true, data: { outcome: 'applied', reason: null } })
      },
      offlineSale: { getReadiness: async () => ({ ok: true, data: offlineSale }) },
      catalog: {
        getProduct: async ({ uuid }: { uuid: string }) =>
          uuid === KNOWN_PRODUCT
            ? { ok: true, data: { uuid, name: 'Juhayna Milk 1L' } }
            : {
                ok: false,
                error: {
                  category: 'not_found',
                  message: 'Product not found',
                  retryable: false
                }
              }
      }
    }
  })
}

async function renderPage(
  getReadiness: () => Promise<unknown>,
  offlineSale?: OfflineSaleReadiness
): Promise<ReturnType<typeof mount>> {
  installPosApi(getReadiness, offlineSale)
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(PreparationPage, { global: { plugins: [pinia, i18n] } })
  await flushPromises()

  return wrapper
}

describe('PreparationPage', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    i18n.global.locale.value = 'en'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('mounts the offline-selling readiness panel, so physical-presence status is reachable', async () => {
    wrapper = await renderPage(async () => ({ ok: true, data: readiness() }), PHYSICAL_PRESENCE)

    const panel = wrapper.get('.offline-sale-readiness')
    expect(panel.text()).toContain(String(i18n.global.t('offlineSale.modePhysicalPresence')))
    expect(panel.text()).toContain(String(i18n.global.t('offlineSale.noPreparationNeeded')))
    expect(panel.text()).toContain(
      String(i18n.global.t('offlineSale.pendingUploads', { count: 2 }))
    )
  })

  it('does not present preparation as a requirement in physical-presence mode', async () => {
    wrapper = await renderPage(
      async () => ({
        ok: true,
        data: readiness(
          {},
          {
            unresolvedOperations: [
              { operationUuid: '00000000-0000-4000-8000-000000000001' }
            ] as unknown as PreparationReadiness['unresolvedOperations']
          }
        )
      }),
      PHYSICAL_PRESENCE
    )

    const prepare = String(i18n.global.t('preparation.actions.prepare'))
    expect(wrapper.findAll('button').some((button) => button.text() === prepare)).toBe(false)
    expect(wrapper.find('[data-testid="preparation-time-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preparation-quantity-panel"]').exists()).toBe(false)
    expect(wrapper.text()).toContain(
      String(i18n.global.t('preparation.descriptionPhysicalPresence'))
    )
    expect(wrapper.text()).not.toContain(String(i18n.global.t('preparation.empty.title')))
    // An ambiguous operation is reported whatever the mode.
    expect(wrapper.find('[data-testid="preparation-unresolved"]').exists()).toBe(true)
  })

  it('keeps the preparation requirement for allocation-only workstations', async () => {
    wrapper = await renderPage(async () => ({ ok: true, data: readiness() }))

    const prepare = String(i18n.global.t('preparation.actions.prepare'))
    expect(wrapper.findAll('button').some((button) => button.text() === prepare)).toBe(true)
    expect(wrapper.find('[data-testid="preparation-time-panel"]').exists()).toBe(true)
    expect(wrapper.get('.offline-sale-readiness').text()).toContain(
      String(i18n.global.t('offlineSale.modeLegacy'))
    )
  })

  it('shows expired time as a refusal and partial time as a warning', async () => {
    wrapper = await renderPage(async () => ({
      ok: true,
      data: readiness({ state: 'expired', remainingSeconds: 0 })
    }))
    expect(wrapper.get('[data-testid="preparation-time-panel"] p.text-4xl').classes()).toContain(
      'text-err'
    )
    wrapper.unmount()

    wrapper = await renderPage(async () => ({
      ok: true,
      data: readiness({ state: 'partial_time' })
    }))
    expect(
      wrapper.get('[data-testid="preparation-time-panel"] .app-status-chip').classes()
    ).toContain('app-status-chip--warning')
  })

  it('keeps full and short quantity coverage visually distinct', async () => {
    wrapper = await renderPage(async () => ({
      ok: true,
      data: readiness({}, { quantity: { state: 'partial', products: [] } })
    }))

    expect(
      wrapper.get('[data-testid="preparation-quantity-panel"] .app-status-chip').classes()
    ).toContain('app-status-chip--warning')
  })

  it('reports unresolved operations instead of showing them as prepared', async () => {
    wrapper = await renderPage(async () => ({
      ok: true,
      data: readiness(
        { newlyObservedRestriction: 'required_window' },
        {
          unresolvedOperations: [
            { operationUuid: '00000000-0000-4000-8000-000000000001' }
          ] as unknown as PreparationReadiness['unresolvedOperations']
        }
      )
    }))

    const unresolved = wrapper.get('[data-testid="preparation-unresolved"]')
    expect(unresolved.attributes('role')).toBe('status')
    expect(unresolved.text()).toBe(String(i18n.global.t('preparation.unresolved', { count: 1 })))
    expect(wrapper.get('[data-testid="preparation-time-panel"] .app-banner').classes()).toContain(
      'app-banner--warning'
    )
  })

  it('names products from the local catalog and keeps the uuid for unknown ones', async () => {
    wrapper = await renderPage(async () => ({
      ok: true,
      data: readiness(
        {},
        {
          quantity: {
            state: 'partial',
            products: [KNOWN_PRODUCT, UNKNOWN_PRODUCT].map((productUuid) => ({
              productUuid,
              state: 'full',
              usableNowMilli: 2500,
              coveredForWindowMilli: 0,
              shortLivedMilli: 0,
              heldNotSpendableMilli: 0
            }))
          } as unknown as PreparationReadiness['quantity']
        }
      )
    }))
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="preparation-quantity-panel"] tbody tr')
    expect(rows[0].text()).toContain('Juhayna Milk 1L')
    expect(rows[0].text()).not.toContain(KNOWN_PRODUCT)
    expect(rows[1].text()).toContain(UNKNOWN_PRODUCT)
    expect(rows[0].text()).toContain('2.5')
  })

  it('shows the localized error message instead of the raw failure', async () => {
    wrapper = await renderPage(async () => {
      throw new Error('ipc exploded')
    })

    const alerts = wrapper.findAll('.app-inline-error').map((alert) => alert.text())
    const expected = String(i18n.global.t('preparation.readinessUnavailable'))

    expect(expected).not.toBe('preparation.readinessUnavailable')
    expect(alerts).toContain(expected)
    expect(alerts.join(' ')).not.toContain('ipc exploded')
  })
})
