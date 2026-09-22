// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import RefundDialog from './RefundDialog.vue'

/**
 * Plan §7 -- the first RTL/narrow-viewport component test in this repo (no prior example
 * existed); this establishes the pattern other modules can follow.
 */

const UUID_A = '00000000-0000-4000-8000-000000000001'
const UUID_B = '00000000-0000-4000-8000-000000000002'

function refundableFixture(): { ok: true; data: Record<string, unknown> } {
  return {
    ok: true,
    data: {
      invoiceLocalUuid: UUID_A,
      invoiceRemoteUuid: UUID_B,
      offlineNumber: 'POS-1',
      serverNumber: null,
      displayNumber: 'POS-1',
      soldAt: '2026-01-01T00:00:00Z',
      currency: 'USD',
      currencyExponent: 2,
      grandTotalAmount: 3000,
      refundCapable: true,
      lines: [
        {
          invoiceItemRemoteUuid: UUID_B,
          productName: 'Widget',
          quantitySold: '3.000',
          quantityRefunded: '0.000',
          quantityRefundable: '3.000',
          feasibility: { tier: 'ok', reasons: [] },
          taxMode: 'exclusive'
        }
      ]
    }
  }
}

function installPosApi(): void {
  ;(globalThis as unknown as { window: Window }).window.posApi = {
    refunds: {
      getRefundable: async () => refundableFixture(),
      preview: async () => ({
        ok: true,
        data: {
          previewId: 'preview-1',
          invoiceLocalUuid: UUID_A,
          stockReturned: true,
          lines: [
            {
              invoiceItemRemoteUuid: UUID_B,
              productName: 'Widget',
              quantityMilli: 1000,
              subtotalAmount: 1000,
              discountAmount: 0,
              taxAmount: 0,
              totalAmount: 1000
            }
          ],
          subtotalAmount: 1000,
          discountTotalAmount: 0,
          taxTotalAmount: 0,
          grandTotalAmount: 1000,
          currency: 'USD',
          currencyExponent: 2
        }
      }),
      submit: async () => ({
        ok: true,
        data: {
          localRefundUuid: UUID_A,
          state: 'accepted',
          remoteUuid: UUID_B,
          refundNumber: 'REF-1',
          errorCode: null
        }
      }),
      resume: async () => ({
        ok: true,
        data: {
          localRefundUuid: UUID_A,
          state: 'accepted',
          remoteUuid: UUID_B,
          refundNumber: 'REF-1',
          errorCode: null
        }
      }),
      cancelPrepared: async () => ({ ok: true, data: { cancelled: true } })
    },
    sales: {
      listInvoices: async () => ({ ok: true, data: { invoices: [], nextCursor: null } }),
      getInvoice: async () => ({ ok: true, data: null })
    }
  } as unknown as Window['posApi']
}

async function renderDialog(): Promise<VueWrapper> {
  installPosApi()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(RefundDialog, {
    props: { open: true, invoiceLocalUuid: UUID_A },
    global: { plugins: [pinia, i18n] },
    attachTo: document.body
  })
  await flushPromises()
  return wrapper
}

describe('RefundDialog', () => {
  beforeEach(() => {
    document.documentElement.lang = ''
    document.documentElement.dir = ''
    i18n.global.locale.value = 'en'
  })

  it('renders in English with the refund line visible and accessible controls', async () => {
    const wrapper = await renderDialog()

    expect(document.body.textContent).toContain('Widget')
    // The dialog is a real ARIA dialog with a labelled heading (AppDialog's contract).
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull()
    // QuantityControl-equivalent buttons carry accessible names, not bare icons.
    const increaseButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Increase refund quantity'
    )
    expect(increaseButton).toBeDefined()

    wrapper.unmount()
  })

  it('renders in Arabic under RTL direction', async () => {
    i18n.global.locale.value = 'ar'
    document.documentElement.dir = 'rtl'
    document.documentElement.lang = 'ar'

    const localeStore = useLocaleStore()
    // Set directly -- this test exercises the dialog's own rendering, not the full locale
    // initialization flow already covered by locale.store.test.ts.
    ;(localeStore as unknown as { locale: string }).locale = 'ar'

    const wrapper = await renderDialog()

    expect(document.documentElement.dir).toBe('rtl')
    // The Arabic translation of the dialog title is present.
    expect(document.body.textContent).toContain('إرجاع / استرداد')

    wrapper.unmount()
  })

  it('renders usably at a narrow (phone-width) viewport', async () => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true })

    const wrapper = await renderDialog()

    // Nothing critical is hidden or unmounted at narrow width -- the same accessible controls
    // and content are present as at full width.
    expect(document.body.textContent).toContain('Widget')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    wrapper.unmount()
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
  })

  it('increasing a line quantity enables the review action', async () => {
    const wrapper = await renderDialog()

    const increaseButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Increase refund quantity'
    ) as HTMLButtonElement

    const reviewButtonBefore = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Review refund'
    ) as HTMLButtonElement
    expect(reviewButtonBefore.disabled).toBe(true)

    increaseButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    const reviewButtonAfter = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Review refund'
    ) as HTMLButtonElement
    expect(reviewButtonAfter.disabled).toBe(false)

    wrapper.unmount()
  })
})
