// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SyncFailure, SyncStatus } from '@shared/contracts/sync.contract'
import { i18n } from '@renderer/i18n'
import { useSyncStore } from '../store'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import SyncPage from './SyncPage.vue'

const FAILURE: SyncFailure = {
  localQueueUuid: '00000000-0000-4000-8000-000000000001',
  invoiceLocalUuid: '00000000-0000-4000-8000-000000000002',
  offlineNumber: 'POS-000001-20260903-000001',
  totalAmount: 12_345,
  currency: 'USD',
  currencyExponent: 2,
  soldAt: '2026-09-03T10:00:00.000Z',
  cashierUuid: '44444444-4444-4444-8444-444444444444',
  shiftUuid: '99999999-9999-4999-8999-999999999999',
  state: 'rejected',
  backendCode: 'DESKTOP_ALLOCATION_PROOF_REQUIRED',
  message: 'Allocation proof is required for every tracked invoice line.',
  traceId: 'trace-abc-123',
  queuedAt: '2026-09-03T10:00:00.000Z'
}

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    state: 'idle',
    pausedReason: null,
    counts: { pending: 2, uploading: 1, retryableError: 3, conflict: 1, rejected: 4 },
    ...overrides
  }
}

async function renderPage(
  options: {
    status?: SyncStatus
    failures?: SyncFailure[]
    connectivity?: 'online' | 'offline'
  } = {}
): Promise<{
  wrapper: ReturnType<typeof mount>
  sync: ReturnType<typeof useSyncStore>
}> {
  const pinia = createPinia()
  setActivePinia(pinia)

  const sync = useSyncStore()
  const connectivity = useConnectivityStore()

  vi.spyOn(sync, 'initialize').mockImplementation(async () => {
    sync.status = options.status ?? status()
  })
  vi.spyOn(sync, 'loadFailures').mockImplementation(async () => {
    sync.failures = options.failures ?? []
  })
  vi.spyOn(sync, 'uploadNow').mockResolvedValue(undefined)
  vi.spyOn(sync, 'loadMoreFailures').mockResolvedValue(undefined)
  connectivity.snapshot = {
    status: options.connectivity ?? 'online',
    networkAvailable: options.connectivity !== 'offline',
    backendReachable: options.connectivity !== 'offline',
    checkedAt: null,
    lastBackendReachableAt: null,
    reason: 'probe_succeeded'
  }

  const wrapper = mount(SyncPage, { global: { plugins: [pinia, i18n] } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()

  return { wrapper, sync }
}

describe('SyncPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    i18n.global.locale.value = 'en'
  })

  it('shows every queue count from the live status', async () => {
    const { wrapper } = await renderPage()
    const text = wrapper.text()

    expect(text).toContain('Pending')
    expect(text).toContain('Uploading')
    expect(text).toContain('Waiting to retry')
    expect(text).toContain('Conflicts')
    expect(text).toContain('Rejected')
    // The five real numbers, not a placeholder.
    for (const count of ['2', '1', '3', '4']) {
      expect(text).toContain(count)
    }
  })

  it('explains a pause using the localized reason, never the raw token', async () => {
    const { wrapper } = await renderPage({
      status: status({ state: 'paused', pausedReason: 'permission-denied' })
    })

    expect(wrapper.text()).toContain('Uploading is paused')
    expect(wrapper.text()).toContain('does not have the invoice upload permission')
    expect(wrapper.text()).not.toContain('permission-denied')
  })

  it('falls back to the generic pause copy for an unrecognized reason', async () => {
    const { wrapper } = await renderPage({
      status: status({ state: 'paused', pausedReason: 'something-new-from-main' })
    })

    expect(wrapper.text()).toContain('Contact your manager')
    expect(wrapper.text()).not.toContain('something-new-from-main')
  })

  it('disables Upload now while paused and says why', async () => {
    const { wrapper } = await renderPage({
      status: status({ state: 'paused', pausedReason: 'license-denied' })
    })
    const button = wrapper.find('button')

    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Uploading is paused, so this cannot run yet.')
  })

  it('disables Upload now while offline and says why', async () => {
    const { wrapper } = await renderPage({ connectivity: 'offline' })

    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('cannot run yet')
  })

  it('requests an upload through the store when pressed', async () => {
    const { wrapper, sync } = await renderPage()

    await wrapper.find('button').trigger('click')

    expect(sync.uploadNow).toHaveBeenCalledTimes(1)
  })

  it('renders a failure with its code, trace id and identifying detail', async () => {
    const { wrapper } = await renderPage({ failures: [FAILURE] })
    const text = wrapper.text()

    expect(text).toContain('POS-000001-20260903-000001')
    expect(text).toContain('DESKTOP_ALLOCATION_PROOF_REQUIRED')
    expect(text).toContain('trace-abc-123')
    expect(text).toContain('Allocation proof is required')
    expect(text).toContain('123.45')
  })

  it('explains an unverifiable stock-tracking rejection in plain language', async () => {
    const { wrapper } = await renderPage({
      failures: [
        {
          ...FAILURE,
          backendCode: 'DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE',
          message: 'The server cannot verify whether one or more products tracked stock.'
        }
      ]
    })
    const text = wrapper.text()

    // PS9: the code alone leaves an operator stuck. This rejection is nobody-on-this-device's
    // fault and no retry can clear it, so the screen has to say both.
    expect(text).toContain('DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE')
    expect(text).toContain('This sale was rung correctly')
    expect(text).toContain('Retrying will not change this')
    expect(text).toContain('Show this invoice to your manager')
  })

  it('shows no invented explanation for a code that has none', async () => {
    const { wrapper } = await renderPage({ failures: [FAILURE] })

    // Only codes with written copy get an explanation; the rest show the backend's own message.
    expect(wrapper.find('.sync-page__failure-reason').exists()).toBe(false)
  })

  it('states that the sale and tender were not reversed', async () => {
    const { wrapper } = await renderPage({ failures: [FAILURE] })
    const text = wrapper.text()

    // PD-3G-1: money already changed hands. The screen must never imply a reversal happened.
    expect(text).toContain('not reversed')
    expect(text).toContain('Money already changed hands')
    expect(text).toContain('verify these sales manually')
  })

  it('offers no control that could mutate a terminal record', async () => {
    const { wrapper } = await renderPage({ failures: [FAILURE] })
    const labels = wrapper.findAll('button').map((button) => button.text().toLowerCase())

    for (const forbidden of ['retry', 'delete', 'void', 'resolve', 'edit', 'release']) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false)
    }
  })

  it('shows the empty state when nothing needs review', async () => {
    const { wrapper } = await renderPage({ failures: [] })

    expect(wrapper.text()).toContain('No uploads need review.')
  })

  it('explains the unverifiable rejection in Arabic too', async () => {
    i18n.global.locale.value = 'ar'
    const { wrapper } = await renderPage({
      failures: [{ ...FAILURE, backendCode: 'DESKTOP_HISTORICAL_STOCK_TRACKING_UNVERIFIABLE' }]
    })

    const reason = wrapper.find('.sync-page__failure-reason').text()
    expect(reason).toContain('تم تسجيل هذه الفاتورة')
    expect(reason).not.toContain('This sale was rung correctly')
  })

  it('renders Arabic copy and keeps the numbers present under RTL', async () => {
    i18n.global.locale.value = 'ar'
    const { wrapper } = await renderPage({
      status: status({ state: 'paused', pausedReason: 'permission-denied' }),
      failures: [FAILURE]
    })
    const text = wrapper.text()

    expect(text).toContain('الرفع متوقف مؤقتاً')
    expect(text).toContain('لا يملك هذا الحساب صلاحية رفع الفواتير')
    expect(text).toContain('لم يتم عكس البيع أو دفعته')
    expect(text).toContain('DESKTOP_ALLOCATION_PROOF_REQUIRED')
    expect(text).toContain('trace-abc-123')
    // No English leaked into the Arabic rendering of the localized copy.
    expect(text).not.toContain('Uploading is paused')
  })
})
