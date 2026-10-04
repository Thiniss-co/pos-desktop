// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type {
  SupportIssue,
  SyncFailure,
  SyncStatus,
  SyncSupportIssues
} from '@shared/contracts/sync.contract'
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

const NO_ISSUES: SyncSupportIssues = {
  needsSupport: [],
  automaticReconciliation: [],
  paymentAwaitingDecision: null
}

function issue(overrides: Partial<SupportIssue> = {}): SupportIssue {
  return {
    kind: 'allocation-identity-conflict',
    reference: 'AD-0123456789AB',
    traceId: 'trace-conflict-1',
    occurredAt: '2026-09-29T12:00:00.000Z',
    updatedAt: '2026-09-29T12:01:00.000Z',
    ownedByCurrentUser: true,
    lines: [{ productName: 'Cola Can', quantity: '2.000' }],
    sendCount: null,
    nextAttemptAfter: null,
    relatedReference: null,
    ...overrides
  }
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
    supportIssues?: SyncSupportIssues
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
  vi.spyOn(sync, 'loadSupportIssues').mockImplementation(async () => {
    sync.supportIssues = options.supportIssues ?? NO_ISSUES
  })
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

  describe('needs attention', () => {
    it('states plainly when nothing needs attention', async () => {
      const { wrapper } = await renderPage()

      expect(wrapper.find('.sync-attention__none').text()).toContain(
        'Nothing needs attention on this workstation.'
      )
    })

    it('uses the singular for one send and one outstanding request', async () => {
      // Live walkthrough: "Sent 1 times" / "1 stock reservation requests" read wrongly in English.
      const { wrapper } = await renderPage({
        supportIssues: {
          needsSupport: [],
          automaticReconciliation: [
            issue({
              kind: 'allocation-request-pending',
              traceId: null,
              updatedAt: null,
              sendCount: 1,
              nextAttemptAfter: null
            })
          ],
          paymentAwaitingDecision: {
            reference: 'SA-0F1E2D3C4B5A',
            claimedAt: '2026-09-29T12:00:00.000Z',
            failureCode: 'allocation-acquisition-unresolved',
            retryAvailable: true,
            legacyDispatchUnknown: false,
            outstandingRequests: 1,
            traceId: null
          }
        }
      })

      expect(wrapper.find('[data-group="automatic"]').text()).toContain('Sent once')
      expect(wrapper.find('[data-group="payment"]').text()).toContain(
        "1 stock reservation request still waiting for the server's answer"
      )
    })

    it('separates support issues from automatic confirmation and the waiting payment', async () => {
      const { wrapper } = await renderPage({
        supportIssues: {
          needsSupport: [
            issue(),
            issue({
              kind: 'legacy-dispatch-uncertainty',
              reference: 'SA-ABCDEF012345',
              traceId: null,
              lines: [{ productName: null, quantity: '1' }]
            })
          ],
          automaticReconciliation: [
            issue({
              kind: 'allocation-request-pending',
              reference: 'AD-FEDCBA987654',
              traceId: null,
              updatedAt: null,
              sendCount: 2,
              nextAttemptAfter: '2026-09-29T12:10:00.000Z'
            })
          ],
          paymentAwaitingDecision: {
            reference: 'SA-0F1E2D3C4B5A',
            claimedAt: '2026-09-29T12:00:00.000Z',
            failureCode: 'allocation-integrity-blocked',
            retryAvailable: false,
            legacyDispatchUnknown: false,
            outstandingRequests: 0,
            traceId: 'trace-conflict-1'
          }
        }
      })

      const support = wrapper.find('[data-group="support"]')
      const automatic = wrapper.find('[data-group="automatic"]')
      const payment = wrapper.find('[data-group="payment"]')

      expect(support.findAll('[data-kind]').map((item) => item.attributes('data-kind'))).toEqual([
        'allocation-identity-conflict',
        'legacy-dispatch-uncertainty'
      ])
      expect(support.text()).toContain('AD-0123456789AB')
      expect(support.text()).toContain('trace-conflict-1')
      expect(support.text()).toContain('cannot be closed from the workstation')
      expect(support.text()).toContain('Product no longer in the catalog')
      expect(automatic.findAll('[data-kind]')).toHaveLength(1)
      expect(automatic.text()).toContain('No action is needed')
      expect(automatic.text()).toContain('Sent 2 times')
      expect(payment.text()).toContain('Retry is not available for this payment')
      expect(payment.find('[data-action="open-pos"]').exists()).toBe(true)
    })

    it('offers no retry, acknowledge, resolve or delete action anywhere in the section', async () => {
      const { wrapper } = await renderPage({
        supportIssues: {
          ...NO_ISSUES,
          needsSupport: [issue(), issue({ kind: 'allocation-request-invalid' })],
          automaticReconciliation: [issue({ kind: 'allocation-request-pending' })]
        }
      })
      const section = wrapper.find('.sync-attention')
      const actions = section
        .findAll('button')
        .map((button) => button.attributes('data-action') ?? button.text())

      expect(new Set(actions)).toEqual(new Set(['copy-reference']))
      expect(section.text()).not.toMatch(/\b(retry|acknowledge|mark as resolved|delete|dismiss)\b/i)
    })

    it("shows another cashier's record without its transaction details", async () => {
      const { wrapper } = await renderPage({
        supportIssues: {
          ...NO_ISSUES,
          needsSupport: [issue({ ownedByCurrentUser: false, lines: null })]
        }
      })
      const item = wrapper.find('[data-kind="allocation-identity-conflict"]')

      expect(item.text()).toContain('Details are shown only to that cashier.')
      expect(item.text()).not.toContain('Cola Can')
      expect(item.text()).toContain('AD-0123456789AB')
    })

    it('copies the support reference, and says so when the clipboard is refused', async () => {
      const writeText = vi
        .fn()
        .mockRejectedValueOnce(new Error('denied'))
        .mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      const { wrapper } = await renderPage({
        supportIssues: { ...NO_ISSUES, needsSupport: [issue()] }
      })

      await wrapper.find('[data-action="copy-reference"]').trigger('click')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(writeText).toHaveBeenCalledWith('AD-0123456789AB')
      expect(wrapper.find('.sync-attention__copy-failed').exists()).toBe(true)

      await wrapper.find('[data-action="copy-reference"]').trigger('click')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(wrapper.find('.sync-attention__copy-failed').exists()).toBe(false)
    })

    it('re-reads the list on mount and whenever main pushes a new queue status', async () => {
      const { sync } = await renderPage()
      const load = vi.mocked(sync.loadSupportIssues)
      const before = load.mock.calls.length
      expect(before).toBeGreaterThanOrEqual(1)

      sync.status = status({ counts: { ...status().counts, pending: 9 } })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(load.mock.calls.length).toBe(before + 1)
    })

    it('has Arabic copy for every attention message', async () => {
      i18n.global.locale.value = 'ar'
      const { wrapper } = await renderPage({
        supportIssues: { ...NO_ISSUES, needsSupport: [issue()] }
      })

      expect(wrapper.find('.sync-attention').text()).toContain('يحتاج إلى الدعم')
      expect(wrapper.find('.sync-attention').text()).not.toContain('sync.attention')
    })
  })
})
